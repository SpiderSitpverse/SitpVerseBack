import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { REDIS_STREAMS } from '../../../../shared/contracts/realtime.contract';
import { OutboxMessage, enqueueOutbox } from '../../../../shared/infrastructure/outbox/outbox.writer';
import { OutboxRelay } from '../../../../shared/infrastructure/outbox/outbox.relay';
import { PrismaService } from '../../../../shared/infrastructure/prisma.service';
import { AssistanceEvent, EventsOf } from '../../domain/events/assistance-events';
import {
  AssistanceRepositoryPort,
  NewCall,
} from '../../domain/ports/assistance-repository.port';
import {
  AssistanceCallModel,
  AssistanceKind,
  AssistanceSummary,
  CallStatus,
  CancelFailure,
  CancelResult,
  ClaimFailure,
  ClaimModel,
  ClaimResult,
  ClaimWithUser,
  CompleteResult,
  DeleteIncidentResult,
  IncidentInfo,
  RepairExpense,
  RepairReportInput,
  RepairReportModel,
  SaveReportFailure,
  SaveReportResult,
} from '../../domain/models/assistance.models';

/** Fuerza el rollback de una transacción cuando se pierde una carrera de negocio. */
class Abort<Reason extends string> extends Error {
  constructor(readonly reason: Reason) {
    super(reason);
  }
}

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
const isForeignKeyViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003';

const toMessage = (event: AssistanceEvent): OutboxMessage => ({
  eventId: event.eventId,
  channel: REDIS_STREAMS.ASSISTANCE,
  payload: event,
});

/**
 * Adapter Prisma de asistencia. Reglas de oro de este archivo:
 *  1. Toda transición es compare-and-set (`UPDATE ... WHERE <estado esperado>`).
 *  2. Los eventos se escriben en el outbox DENTRO de la misma transacción.
 *  3. Tras confirmar, `relay.nudge()` despierta al relay para publicar sin esperar el sondeo.
 */
@Injectable()
export class PrismaAssistanceRepository implements AssistanceRepositoryPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly relay: OutboxRelay,
  ) {}

  // ─────────────── incidentes ───────────────

  async createIncident(
    data: { busId: string; reportedById: string; reportedByName?: string; type: string; description?: string },
    eventsOf: Parameters<AssistanceRepositoryPort['createIncident']>[1],
  ) {
    const incident = await this.prisma.$transaction(async (tx) => {
      const created = await tx.driverIncident.create({ data });
      await enqueueOutbox(tx, eventsOf(created).map(toMessage));
      return created;
    });
    this.relay.nudge();
    return incident;
  }

  findIncident(id: string) {
    return this.prisma.driverIncident.findUnique({ where: { id } });
  }

  listIncidents() {
    return this.prisma.driverIncident.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async deleteIncident(
    id: string,
    eventsOf: EventsOf<{ id: string; busId: string }>,
  ): Promise<DeleteIncidentResult> {
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const incident = await tx.driverIncident.findUnique({ where: { id } });
        if (!incident) throw new Abort<'NOT_FOUND'>('NOT_FOUND');

        // Bloquea las alertas del incidente: un conductor que acepte ahora espera y, al desbloquearse,
        // su UPDATE ya no encuentra la fila (no queda ninguna aceptación huérfana).
        const locked = await tx.$queryRaw<{ id: string; status: string; claimedCount: number }[]>`
          SELECT "id", "status", "claimedCount" FROM "assistance_calls"
           WHERE "incidentId" = ${id} FOR UPDATE`;
        if (locked.some((c) => c.claimedCount > 0 || c.status !== 'OPEN')) {
          throw new Abort<'IN_PROGRESS'>('IN_PROGRESS');
        }

        // `incidentId` de la alerta no tiene clave foránea: se borran aparte (sin aceptaciones que arrastrar).
        await tx.assistanceCall.deleteMany({ where: { incidentId: id } });
        await tx.driverIncident.delete({ where: { id } });

        const ok = { ok: true as const, busId: incident.busId, removedCalls: locked.length };
        await enqueueOutbox(tx, eventsOf({ id, busId: incident.busId }).map(toMessage));
        return ok;
      });
      this.relay.nudge();
      return result;
    } catch (e) {
      if (e instanceof Abort) return { ok: false, reason: e.reason as 'NOT_FOUND' | 'IN_PROGRESS' };
      throw e;
    }
  }

  // ─────────────── alertas ───────────────

  async createSupportCallForIncident(
    incidentId: string,
    data: NewCall,
    eventsOf: EventsOf<AssistanceCallModel>,
  ) {
    try {
      const call = await this.prisma.$transaction(async (tx) => {
        const cas = await tx.driverIncident.updateMany({
          where: { id: incidentId, status: 'REPORTED' },
          data: { status: 'HELP_REQUESTED' },
        });
        if (cas.count === 0) throw new Abort('ALREADY_REQUESTED');
        const created = await tx.assistanceCall.create({ data: { ...data, incidentId } });
        await enqueueOutbox(tx, eventsOf(created).map(toMessage));
        return created;
      });
      this.relay.nudge();
      return call;
    } catch (e) {
      if (e instanceof Abort) return null;
      throw e;
    }
  }

  async createCall(data: NewCall, eventsOf: EventsOf<AssistanceCallModel>) {
    try {
      const call = await this.prisma.$transaction(async (tx) => {
        const created = await tx.assistanceCall.create({ data });
        await enqueueOutbox(tx, eventsOf(created).map(toMessage));
        return created;
      });
      this.relay.nudge();
      return { call, created: true };
    } catch (e) {
      if (!isUniqueViolation(e) || data.kind !== 'REPAIR') throw e;
      // Índice único parcial: ya hay una reparación abierta para este bus (sin eventos).
      const existing = await this.prisma.assistanceCall.findFirstOrThrow({
        where: { busId: data.busId, kind: 'REPAIR', status: { not: 'COMPLETED' } },
      });
      // Si esa reparación no venía de ningún incidente, queda enlazada al que la pide ahora
      // (así, al eliminar ese incidente, se elimina también la solicitud).
      if (data.incidentId && existing.incidentId === null) {
        await this.prisma.assistanceCall.updateMany({
          where: { id: existing.id, incidentId: null },
          data: { incidentId: data.incidentId },
        });
        return { call: { ...existing, incidentId: data.incidentId }, created: false };
      }
      return { call: existing, created: false };
    }
  }

  findCall(id: string) {
    return this.prisma.assistanceCall.findUnique({ where: { id } });
  }

  listCalls(filter?: { kind?: AssistanceKind; status?: CallStatus }) {
    return this.prisma.assistanceCall.findMany({
      where: { kind: filter?.kind, status: filter?.status },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listClaims(callIds: string[]): Promise<ClaimWithUser[]> {
    if (callIds.length === 0) return [];
    const rows = await this.prisma.assistanceClaim.findMany({
      where: { callId: { in: callIds } },
      include: { user: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(({ user, ...claim }) => ({ ...claim, userName: user.name }));
  }

  // ─────────────── aceptar / cancelar / completar ───────────────

  async tryClaim(
    callId: string,
    userId: string,
    data: { busId: string | null; arriveBy: Date },
    eventsOf: EventsOf<{ call: AssistanceCallModel; claim: ClaimModel; filled: boolean }>,
  ): Promise<ClaimResult> {
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // 1) UNIQUE (callId, userId): el mismo usuario no ocupa dos cupos (ni retoma uno cancelado).
        let claim: ClaimModel;
        try {
          claim = await tx.assistanceClaim.create({ data: { callId, userId, ...data } });
        } catch (e) {
          if (isUniqueViolation(e)) throw new Abort<ClaimFailure>('ALREADY_CLAIMED');
          if (isForeignKeyViolation(e)) throw new Abort<ClaimFailure>('NOT_FOUND');
          throw e;
        }

        // 2) Compare-and-set: solo suma si la alerta sigue abierta y con cupo.
        const updated = await tx.$executeRaw`
          UPDATE "assistance_calls"
             SET "claimedCount" = "claimedCount" + 1,
                 "status" = CASE WHEN "claimedCount" + 1 >= "slots"
                                 THEN 'FILLED'::"CallStatus" ELSE "status" END
           WHERE "id" = ${callId}
             AND "status" = 'OPEN'
             AND "claimedCount" < "slots"`;
        if (updated === 0) {
          const call = await tx.assistanceCall.findUnique({ where: { id: callId } });
          throw new Abort<ClaimFailure>(
            !call ? 'NOT_FOUND' : call.status === 'COMPLETED' ? 'CLOSED' : 'FULL',
          );
        }

        const call = (await tx.assistanceCall.findUnique({ where: { id: callId } }))!;
        const ok = { ok: true as const, call, claim, filled: call.status === 'FILLED' };
        await enqueueOutbox(tx, eventsOf(ok).map(toMessage));
        return ok;
      });
      this.relay.nudge();
      return result;
    } catch (e) {
      if (!(e instanceof Abort)) throw e;
      let reason = e.reason as ClaimFailure;
      if (reason === 'ALREADY_CLAIMED') {
        // ¿Es porque el admin le canceló su aceptación? (la transacción abortada ya no se puede consultar)
        const previous = await this.prisma.assistanceClaim.findUnique({
          where: { callId_userId: { callId, userId } },
        });
        if (previous?.status === 'CANCELLED') reason = 'CANCELLED';
      }
      return { ok: false, reason };
    }
  }

  async cancelClaim(
    callId: string,
    claimId: string,
    cancelledById: string,
    eventsOf: EventsOf<{ call: AssistanceCallModel; claim: ClaimModel }>,
  ): Promise<CancelResult> {
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.assistanceClaim.findFirst({ where: { id: claimId, callId } });
        if (!existing) throw new Abort<CancelFailure>('NOT_FOUND');

        // CAS: solo cancela una aceptación que siga ACTIVA (dos cancelaciones simultáneas: gana una).
        const cas = await tx.assistanceClaim.updateMany({
          where: { id: claimId, status: 'ACTIVE' },
          data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById },
        });
        if (cas.count === 0) throw new Abort<CancelFailure>('NOT_ACTIVE');

        // Libera el cupo; una alerta llena vuelve a OPEN. Si ya se completó, rollback de todo.
        const freed = await tx.$executeRaw`
          UPDATE "assistance_calls"
             SET "claimedCount" = "claimedCount" - 1,
                 "status" = CASE WHEN "status" = 'FILLED'
                                 THEN 'OPEN'::"CallStatus" ELSE "status" END
           WHERE "id" = ${callId} AND "status" IN ('OPEN', 'FILLED')`;
        if (freed === 0) throw new Abort<CancelFailure>('COMPLETED');

        const call = (await tx.assistanceCall.findUnique({ where: { id: callId } }))!;
        const claim = (await tx.assistanceClaim.findUnique({ where: { id: claimId } }))!;
        const ok = { ok: true as const, call, claim };
        await enqueueOutbox(tx, eventsOf(ok).map(toMessage));
        return ok;
      });
      this.relay.nudge();
      return result;
    } catch (e) {
      if (e instanceof Abort) return { ok: false, reason: e.reason as CancelFailure };
      throw e;
    }
  }

  async complete(
    callId: string,
    eventsOf: EventsOf<CompleteResult>,
  ): Promise<CompleteResult | null> {
    const result = await this.prisma.$transaction((tx) => this.completeWithin(tx, callId, eventsOf));
    if (result) this.relay.nudge();
    return result;
  }

  /**
   * Cierra la alerta (una sola vez), acredita los puntos y encola el evento, DENTRO de la transacción
   * recibida. Lo usan `complete` y `saveRepairReport` (que cierra la alerta al finalizar el informe).
   */
  private async completeWithin(
    tx: Prisma.TransactionClient,
    callId: string,
    eventsOf: EventsOf<CompleteResult>,
  ): Promise<CompleteResult | null> {
    const cas = await tx.assistanceCall.updateMany({
      where: { id: callId, status: { in: ['OPEN', 'FILLED'] } },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    if (cas.count === 0) return null; // otro "completar" ya ganó: no se paga dos veces

    const call = (await tx.assistanceCall.findUnique({ where: { id: callId } }))!;
    const claims = await tx.assistanceClaim.findMany({ where: { callId, status: 'ACTIVE' } });
    const awardedUserIds = claims.map((c) => c.userId);

    // Libro de puntos: UNIQUE (userId, callId) es una segunda defensa contra el pago doble.
    await tx.rewardEntry.createMany({
      data: awardedUserIds.map((userId) => ({ userId, callId, points: call.rewardPoints })),
      skipDuplicates: true,
    });

    const done = { call, awardedUserIds };
    await enqueueOutbox(tx, eventsOf(done).map(toMessage));
    return done;
  }

  // ─────────────── informes de reparación ───────────────

  async saveRepairReport(
    callId: string,
    mechanic: { id: string; name: string },
    data: RepairReportInput,
    finalize: boolean,
    eventsOnComplete: EventsOf<CompleteResult>,
  ): Promise<SaveReportResult> {
    const fields = {
      damages: data.damages,
      replacedParts: data.replacedParts,
      expenses: data.expenses as unknown as Prisma.InputJsonValue,
      busPhotos: data.busPhotos,
      partPhotos: data.partPhotos,
    };
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // 1) Crear el borrador o actualizarlo SOLO si sigue abierto (compare-and-set sobre completedAt).
        const existing = await tx.repairReport.findUnique({ where: { callId } });
        if (!existing) {
          await tx.repairReport.create({
            data: { callId, mechanicId: mechanic.id, mechanicName: mechanic.name, ...fields },
          });
        } else {
          const updated = await tx.repairReport.updateMany({
            where: { callId, completedAt: null },
            data: fields,
          });
          if (updated.count === 0) throw new Abort<SaveReportFailure>('REPORT_FINALIZED');
        }

        // 2) Al finalizar: cerrar la alerta en la MISMA transacción (todo o nada).
        let completion: CompleteResult | null = null;
        if (finalize) {
          completion = await this.completeWithin(tx, callId, eventsOnComplete);
          if (!completion) throw new Abort<SaveReportFailure>('CALL_CLOSED'); // ya la cerró otro: se deshace todo
          await tx.repairReport.update({ where: { callId }, data: { completedAt: new Date() } });
        }

        const report = (await tx.repairReport.findUnique({ where: { callId } }))!;
        return { ok: true as const, report: this.toReport(report), completion };
      });
      if (result.completion) this.relay.nudge();
      return result;
    } catch (e) {
      if (e instanceof Abort) return { ok: false, reason: e.reason as SaveReportFailure };
      throw e;
    }
  }

  async findRepairReport(callId: string): Promise<RepairReportModel | null> {
    const row = await this.prisma.repairReport.findUnique({ where: { callId } });
    return row ? this.toReport(row) : null;
  }

  async listRepairReports(filter: { mechanicId?: string }): Promise<RepairReportModel[]> {
    const rows = await this.prisma.repairReport.findMany({
      where: { mechanicId: filter.mechanicId },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((row) => this.toReport(row));
  }

  private toReport(row: {
    id: string; callId: string; mechanicId: string; mechanicName: string; damages: string;
    replacedParts: string; expenses: Prisma.JsonValue; busPhotos: Prisma.JsonValue;
    partPhotos: Prisma.JsonValue; createdAt: Date; updatedAt: Date; completedAt: Date | null;
  }): RepairReportModel {
    return {
      ...row,
      expenses: row.expenses as unknown as RepairExpense[],
      busPhotos: row.busPhotos as unknown as string[],
      partPhotos: row.partPhotos as unknown as string[],
    };
  }

  // ─────────────── datos para enriquecer y resumir ───────────────

  async findIncidentInfos(ids: string[]): Promise<Map<string, IncidentInfo>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.driverIncident.findMany({ where: { id: { in: ids } } });
    return new Map(
      rows.map((r) => [
        r.id,
        { id: r.id, type: r.type, description: r.description, reportedByName: r.reportedByName, createdAt: r.createdAt },
      ]),
    );
  }

  async summary(): Promise<AssistanceSummary> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [incidentsLast24h, openSupportCalls, openRepairCalls, repairsInProgress, repairsCompletedLast24h, openBlockages] =
      await Promise.all([
        this.prisma.driverIncident.count({ where: { createdAt: { gte: since } } }),
        this.prisma.assistanceCall.count({ where: { kind: 'DRIVER_SUPPORT', status: { in: ['OPEN', 'FILLED'] } } }),
        this.prisma.assistanceCall.count({ where: { kind: 'REPAIR', status: 'OPEN' } }),
        this.prisma.assistanceCall.count({ where: { kind: 'REPAIR', status: 'FILLED' } }),
        this.prisma.assistanceCall.count({ where: { kind: 'REPAIR', status: 'COMPLETED', completedAt: { gte: since } } }),
        this.prisma.driverIncident.count({ where: { blockageStatus: 'OPEN' } }),
      ]);
    return { incidentsLast24h, openSupportCalls, openRepairCalls, repairsInProgress, repairsCompletedLast24h, openBlockages };
  }

  // ─────────────── eventos sueltos y puntos ───────────────

  async enqueueEvents(events: AssistanceEvent[]) {
    await this.prisma.$transaction((tx) => enqueueOutbox(tx, events.map(toMessage)));
    this.relay.nudge();
  }

  async getPoints(userId: string) {
    const { _sum } = await this.prisma.rewardEntry.aggregate({
      where: { userId },
      _sum: { points: true },
    });
    return _sum.points ?? 0;
  }
}
