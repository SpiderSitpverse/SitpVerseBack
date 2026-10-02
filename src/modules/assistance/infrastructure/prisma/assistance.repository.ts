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
  CallStatus,
  CancelFailure,
  CancelResult,
  ClaimFailure,
  ClaimModel,
  ClaimResult,
  ClaimWithUser,
  CompleteResult,
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
    data: { busId: string; reportedById: string; type: string; description?: string },
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
    const result = await this.prisma.$transaction(async (tx) => {
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
    });
    if (result) this.relay.nudge();
    return result;
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
