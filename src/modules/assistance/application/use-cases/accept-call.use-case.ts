import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  DISTRIBUTED_LOCK,
  DistributedLockPort,
} from '../../../../shared/domain/distributed-lock.port';
import { ConflictError, NotFoundError } from '../../../../shared/domain/errors';
import { AuthenticatedUser } from '../../../identity/public';
import {
  ASSISTANCE_REPOSITORY,
  AssistanceRepositoryPort,
} from '../../domain/ports/assistance-repository.port';
import { BUS_DIRECTORY, BusDirectoryPort } from '../../domain/ports/bus-directory.port';
import {
  CLAIM_FAILURE_MESSAGE,
  assertNotOwnIncident,
  assertRoleCanAccept,
} from '../../domain/assistance.policy';
import { ROLE_FOR_KIND } from '../../domain/models/assistance.models';
import { assistanceEvent } from '../assistance-event.factory';

/** Una clave por alerta: solo compiten entre sí quienes aceptan LA MISMA alerta. */
export const callLockKey = (callId: string) => `lock:assistance-call:${callId}`;

const DEFAULT_ARRIVAL_MINUTES = 20;

/**
 * Aceptar una alerta (conductor de apoyo o mecánico): los PRIMEROS en llegar toman los cupos.
 *
 * Es el caso de uso donde ocurre la concurrencia. Tres capas, de afuera hacia adentro:
 *  1. Lock distribuido FIFO por alerta → atiende en orden estricto de llegada.
 *  2. `tryClaim` atómico en BD         → `UPDATE ... WHERE claimedCount < slots` (decide quién gana).
 *  3. CHECK + UNIQUE en Postgres       → última barrera si las capas anteriores fallaran.
 *
 * Al aceptar se fija un plazo (`arriveBy` = ahora + ASSISTANCE_ARRIVAL_MINUTES, 20 por
 * defecto) que ven el que aceptó y el admin. Los eventos (`call.progress`, y `call.closed`
 * si se llenó el último cupo) viajan por el outbox, en la misma transacción que el cupo.
 */
@Injectable()
export class AcceptCallUseCase {
  constructor(
    @Inject(ASSISTANCE_REPOSITORY) private readonly repo: AssistanceRepositoryPort,
    @Inject(BUS_DIRECTORY) private readonly buses: BusDirectoryPort,
    @Inject(DISTRIBUTED_LOCK) private readonly lock: DistributedLockPort,
    private readonly config: ConfigService,
  ) {}

  async execute(actor: AuthenticatedUser, callId: string, traceId = randomUUID()) {
    const call = await this.repo.findCall(callId);
    if (!call) throw new NotFoundError(CLAIM_FAILURE_MESSAGE.NOT_FOUND);

    // Reglas baratas primero, antes de ponerse en la cola del lock.
    assertRoleCanAccept(call, actor);
    if (call.kind === 'DRIVER_SUPPORT' && call.incidentId) {
      assertNotOwnIncident(await this.repo.findIncident(call.incidentId), actor);
    }

    const bus = actor.role === 'DRIVER' ? await this.buses.findBusOfDriver(actor.id) : null;
    const minutes = Number(
      this.config.get('ASSISTANCE_ARRIVAL_MINUTES', DEFAULT_ARRIVAL_MINUTES),
    );
    const arriveBy = new Date(Date.now() + minutes * 60_000);

    const { value: result } = await this.lock.withLock(
      callLockKey(callId),
      () =>
        this.repo.tryClaim(callId, actor.id, { busId: bus?.id ?? null, arriveBy }, (r) => {
          const summary = {
            callId,
            kind: r.call.kind,
            busId: r.call.busId,
            claimedCount: r.call.claimedCount,
            slots: r.call.slots,
          };
          const events = [
            assistanceEvent('call.progress', traceId, { roles: ['ADMIN'] }, {
              ...summary,
              claim: {
                id: r.claim.id,
                userId: actor.id,
                name: actor.name,
                bus,
                arriveBy: r.claim.arriveBy.toISOString(),
              },
            }),
          ];
          if (r.filled) {
            events.push(
              assistanceEvent(
                'call.closed',
                traceId,
                { roles: [ROLE_FOR_KIND[r.call.kind], 'ADMIN'] },
                { ...summary, reason: 'Cupos completos' },
              ),
            );
          }
          return events;
        }),
      { traceId },
    );

    if (!result.ok) {
      throw new ConflictError(CLAIM_FAILURE_MESSAGE[result.reason], { reason: result.reason });
    }
    return {
      traceId,
      accepted: true,
      filled: result.filled,
      call: result.call,
      claim: { ...result.claim, bus },
    };
  }
}
