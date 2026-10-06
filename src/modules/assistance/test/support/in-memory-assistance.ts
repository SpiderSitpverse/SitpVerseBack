import { randomUUID } from 'crypto';
import { AuthenticatedUser } from '../../../identity/public';
import { UserRole } from '../../../../shared/domain/roles';
import { AssistanceEvent, EventsOf } from '../../domain/events/assistance-events';
import {
  AssistanceRepositoryPort,
  NewCall,
} from '../../domain/ports/assistance-repository.port';
import { BusDirectoryPort, BusRef } from '../../domain/ports/bus-directory.port';
import {
  AssistanceCallModel,
  AssistanceKind,
  AssistanceSummary,
  BusInfo,
  IncidentInfo,
  RepairReportInput,
  RepairReportModel,
  SaveReportResult,
  CallStatus,
  CancelResult,
  ClaimModel,
  ClaimResult,
  ClaimWithUser,
  CompleteResult,
  DeleteIncidentResult,
  DriverIncidentModel,
} from '../../domain/models/assistance.models';

/** Cede el event loop para que las operaciones concurrentes se intercalen de verdad. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Repositorio en memoria. Cada método hace `await tick()` ANTES de operar (lecturas
 * "viejas" como en una BD real) y las secciones atómicas (`tryClaim`, `complete`, ...)
 * no tienen `await` entre el chequeo y la escritura, igual que un `UPDATE ... WHERE`.
 *
 * `outbox` simula la tabla outbox: los eventos se agregan SOLO si la operación tuvo éxito,
 * en la misma sección atómica que el cambio de estado.
 */
export class InMemoryAssistanceRepository implements AssistanceRepositoryPort {
  users = new Map<string, AuthenticatedUser>();
  buses = new Map<string, BusRef & { driverId: string | null; route?: string; locationLabel?: string }>();
  incidents = new Map<string, DriverIncidentModel>();
  calls = new Map<string, AssistanceCallModel>();
  claims: ClaimModel[] = [];
  rewards: { userId: string; callId: string; points: number }[] = [];
  reports = new Map<string, RepairReportModel>(); // callId -> informe
  outbox: AssistanceEvent[] = [];

  // ── fixtures ──
  addUser(employeeId: string, name: string, role: UserRole): AuthenticatedUser {
    const user = { id: randomUUID(), employeeId, name, role };
    this.users.set(user.id, user);
    return user;
  }

  addBus(plate = `TMX-${this.buses.size + 1}`, driverId: string | null = null): string {
    const id = randomUUID();
    this.buses.set(id, { id, plate, driverId });
    return id;
  }

  ofType(type: AssistanceEvent['type']) {
    return this.outbox.filter((event) => event.type === type);
  }

  private publish<R>(eventsOf: EventsOf<R>, result: R) {
    this.outbox.push(...eventsOf(result));
  }

  // ── incidentes ──
  async createIncident(
    data: { busId: string; reportedById: string; reportedByName?: string; type: string; description?: string },
    eventsOf: EventsOf<DriverIncidentModel>,
  ) {
    await tick();
    const incident: DriverIncidentModel = {
      id: randomUUID(),
      busId: data.busId,
      reportedById: data.reportedById,
      reportedByName: data.reportedByName ?? null,
      type: data.type,
      description: data.description ?? null,
      status: 'REPORTED',
      createdAt: new Date(),
    };
    this.incidents.set(incident.id, incident);
    this.publish(eventsOf, incident);
    return { ...incident };
  }

  async findIncident(id: string) {
    await tick();
    const incident = this.incidents.get(id);
    return incident ? { ...incident } : null;
  }

  async listIncidents() {
    await tick();
    return [...this.incidents.values()].map((i) => ({ ...i }));
  }

  async deleteIncident(id: string, eventsOf: EventsOf<{ id: string; busId: string }>): Promise<DeleteIncidentResult> {
    await tick();
    const incident = this.incidents.get(id);
    if (!incident) return { ok: false, reason: 'NOT_FOUND' };
    const calls = [...this.calls.values()].filter((c) => c.incidentId === id);
    if (calls.some((c) => c.claimedCount > 0 || c.status !== 'OPEN')) return { ok: false, reason: 'IN_PROGRESS' };
    for (const call of calls) this.calls.delete(call.id);
    this.incidents.delete(id);
    this.publish(eventsOf, { id, busId: incident.busId });
    return { ok: true, busId: incident.busId, removedCalls: calls.length };
  }

  // ── alertas ──
  private newCall(data: NewCall, incidentId: string | null): AssistanceCallModel {
    const call: AssistanceCallModel = {
      id: randomUUID(),
      kind: data.kind,
      incidentId,
      busId: data.busId,
      slots: data.slots,
      claimedCount: 0,
      rewardPoints: data.rewardPoints,
      status: 'OPEN',
      createdById: data.createdById,
      description: data.description ?? null,
      createdAt: new Date(),
      completedAt: null,
    };
    this.calls.set(call.id, call);
    return call;
  }

  async createSupportCallForIncident(
    incidentId: string,
    data: NewCall,
    eventsOf: EventsOf<AssistanceCallModel>,
  ) {
    await tick();
    const incident = this.incidents.get(incidentId);
    if (!incident || incident.status !== 'REPORTED') return null; // CAS
    incident.status = 'HELP_REQUESTED';
    const call = this.newCall(data, incidentId);
    this.publish(eventsOf, call);
    return { ...call };
  }

  async createCall(data: NewCall, eventsOf: EventsOf<AssistanceCallModel>) {
    await tick();
    if (data.kind === 'REPAIR') {
      const open = [...this.calls.values()].find(
        (c) => c.kind === 'REPAIR' && c.busId === data.busId && c.status !== 'COMPLETED',
      ); // equivale al índice único parcial
      if (open) return { call: { ...open }, created: false };
    }
    const call = this.newCall(data, null);
    this.publish(eventsOf, call);
    return { call: { ...call }, created: true };
  }

  async findCall(id: string) {
    await tick();
    const call = this.calls.get(id);
    return call ? { ...call } : null;
  }

  async listCalls(filter?: { kind?: AssistanceKind; status?: CallStatus }) {
    await tick();
    return [...this.calls.values()]
      .filter((c) => !filter?.kind || c.kind === filter.kind)
      .filter((c) => !filter?.status || c.status === filter.status)
      .map((c) => ({ ...c }));
  }

  async listClaims(callIds: string[]): Promise<ClaimWithUser[]> {
    await tick();
    return this.claims
      .filter((c) => callIds.includes(c.callId))
      .map((c) => ({ ...c, userName: this.users.get(c.userId)?.name ?? '?' }));
  }

  // ── aceptar / cancelar / completar ──
  async tryClaim(
    callId: string,
    userId: string,
    data: { busId: string | null; arriveBy: Date },
    eventsOf: EventsOf<{ call: AssistanceCallModel; claim: ClaimModel; filled: boolean }>,
  ): Promise<ClaimResult> {
    await tick();
    // --- sección atómica (sin await) ---
    const call = this.calls.get(callId);
    if (!call) return { ok: false, reason: 'NOT_FOUND' };
    const previous = this.claims.find((c) => c.callId === callId && c.userId === userId);
    if (previous) {
      return { ok: false, reason: previous.status === 'CANCELLED' ? 'CANCELLED' : 'ALREADY_CLAIMED' };
    }
    if (call.status === 'COMPLETED') return { ok: false, reason: 'CLOSED' };
    if (call.status !== 'OPEN' || call.claimedCount >= call.slots) {
      return { ok: false, reason: 'FULL' };
    }

    call.claimedCount++;
    if (call.claimedCount >= call.slots) call.status = 'FILLED';
    const claim: ClaimModel = {
      id: randomUUID(),
      callId,
      userId,
      status: 'ACTIVE',
      busId: data.busId,
      arriveBy: data.arriveBy,
      cancelledAt: null,
      cancelledById: null,
      createdAt: new Date(),
    };
    this.claims.push(claim);
    const result = { ok: true as const, call: { ...call }, claim: { ...claim }, filled: call.status === 'FILLED' };
    this.publish(eventsOf, result);
    return result;
  }

  async cancelClaim(
    callId: string,
    claimId: string,
    cancelledById: string,
    eventsOf: EventsOf<{ call: AssistanceCallModel; claim: ClaimModel }>,
  ): Promise<CancelResult> {
    await tick();
    const claim = this.claims.find((c) => c.id === claimId && c.callId === callId);
    const call = this.calls.get(callId);
    if (!claim || !call) return { ok: false, reason: 'NOT_FOUND' };
    if (claim.status !== 'ACTIVE') return { ok: false, reason: 'NOT_ACTIVE' };
    if (call.status === 'COMPLETED') return { ok: false, reason: 'COMPLETED' };

    claim.status = 'CANCELLED';
    claim.cancelledAt = new Date();
    claim.cancelledById = cancelledById;
    call.claimedCount--;
    if (call.status === 'FILLED') call.status = 'OPEN';
    const result = { ok: true as const, call: { ...call }, claim: { ...claim } };
    this.publish(eventsOf, result);
    return result;
  }

  async complete(
    callId: string,
    eventsOf: EventsOf<CompleteResult>,
  ): Promise<CompleteResult | null> {
    await tick();
    const call = this.calls.get(callId);
    if (!call || call.status === 'COMPLETED') return null; // CAS
    call.status = 'COMPLETED';
    call.completedAt = new Date();
    const awardedUserIds = this.claims
      .filter((c) => c.callId === callId && c.status === 'ACTIVE')
      .map((c) => c.userId);
    for (const userId of awardedUserIds) {
      if (!this.rewards.some((r) => r.userId === userId && r.callId === callId)) {
        this.rewards.push({ userId, callId, points: call.rewardPoints });
      }
    }
    const done = { call: { ...call }, awardedUserIds };
    this.publish(eventsOf, done);
    return done;
  }

  async findIncidentInfos(ids: string[]): Promise<Map<string, IncidentInfo>> {
    await tick();
    return new Map(
      ids.flatMap((id) => {
        const i = this.incidents.get(id);
        return i
          ? [[id, { id, type: i.type, description: i.description, reportedByName: i.reportedByName, createdAt: i.createdAt }] as const]
          : [];
      }),
    );
  }

  async saveRepairReport(
    callId: string,
    mechanic: { id: string; name: string },
    data: RepairReportInput,
    finalize: boolean,
    eventsOnComplete: EventsOf<CompleteResult>,
  ): Promise<SaveReportResult> {
    await tick();
    // --- sección atómica (sin await): informe + cierre de la alerta, todo o nada ---
    const existing = this.reports.get(callId);
    if (existing?.completedAt) return { ok: false, reason: 'REPORT_FINALIZED' };

    const call = this.calls.get(callId);
    if (finalize && (!call || call.status === 'COMPLETED')) return { ok: false, reason: 'CALL_CLOSED' };

    const now = new Date();
    const report: RepairReportModel = existing
      ? { ...existing, ...data, updatedAt: now }
      : {
          id: randomUUID(), callId, mechanicId: mechanic.id, mechanicName: mechanic.name,
          ...data, createdAt: now, updatedAt: now, completedAt: null,
        };

    let completion: CompleteResult | null = null;
    if (finalize) {
      call!.status = 'COMPLETED';
      call!.completedAt = now;
      const awardedUserIds = this.claims.filter((c) => c.callId === callId && c.status === 'ACTIVE').map((c) => c.userId);
      for (const userId of awardedUserIds) {
        if (!this.rewards.some((r) => r.userId === userId && r.callId === callId)) {
          this.rewards.push({ userId, callId, points: call!.rewardPoints });
        }
      }
      completion = { call: { ...call! }, awardedUserIds };
      this.publish(eventsOnComplete, completion);
      report.completedAt = now;
    }
    this.reports.set(callId, report);
    return { ok: true, report: { ...report }, completion };
  }

  async findRepairReport(callId: string) {
    await tick();
    const r = this.reports.get(callId);
    return r ? { ...r } : null;
  }

  async listRepairReports(filter: { mechanicId?: string }) {
    await tick();
    return [...this.reports.values()]
      .filter((r) => !filter.mechanicId || r.mechanicId === filter.mechanicId)
      .map((r) => ({ ...r }));
  }

  async summary(): Promise<AssistanceSummary> {
    await tick();
    const calls = [...this.calls.values()];
    return {
      incidentsLast24h: this.incidents.size,
      openSupportCalls: calls.filter((c) => c.kind === 'DRIVER_SUPPORT' && c.status !== 'COMPLETED').length,
      openRepairCalls: calls.filter((c) => c.kind === 'REPAIR' && c.status === 'OPEN').length,
      repairsInProgress: calls.filter((c) => c.kind === 'REPAIR' && c.status === 'FILLED').length,
      repairsCompletedLast24h: calls.filter((c) => c.kind === 'REPAIR' && c.status === 'COMPLETED').length,
      openBlockages: 0,
    };
  }

  async enqueueEvents(events: AssistanceEvent[]) {
    await tick();
    this.outbox.push(...events);
  }

  async getPoints(userId: string) {
    await tick();
    return this.rewards.filter((r) => r.userId === userId).reduce((sum, r) => sum + r.points, 0);
  }

  pointsOf(userId: string) {
    return this.rewards.filter((r) => r.userId === userId).reduce((sum, r) => sum + r.points, 0);
  }
}

/** Directorio de buses de prueba: lee los buses de fixtures del repositorio en memoria. */
export class FakeBusDirectory implements BusDirectoryPort {
  constructor(private readonly repo: InMemoryAssistanceRepository) {}

  async exists(busId: string) {
    await tick();
    return this.repo.buses.has(busId);
  }

  async findBusOfDriver(userId: string) {
    await tick();
    return [...this.repo.buses.values()].find((b) => b.driverId === userId) ?? null;
  }

  /** Describe buses a partir de los fixtures (placa, troncal, ubicación...). */
  async describe(busIds: string[]): Promise<Map<string, BusInfo>> {
    await tick();
    return new Map(
      busIds.flatMap((id) => {
        const b = this.repo.buses.get(id);
        return b
          ? [[id, {
              id, plate: b.plate, route: b.route ?? 'Troncal Caracas', locationLabel: b.locationLabel ?? 'Calle 26',
              latitude: 4.6, longitude: -74.08, driverName: null,
            }] as const]
          : [];
      }),
    );
  }
}
