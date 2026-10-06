import { Inject, Injectable } from '@nestjs/common';
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
import { CANCEL_FAILURE_MESSAGE } from '../../domain/assistance.policy';
import { assistanceEvent } from '../assistance-event.factory';
import { callLockKey } from './accept-call.use-case';

/**
 * El admin cancela una aceptación que no llegó a tiempo (el plazo `arriveBy` venció y el bus
 * no aparece cerca en el mapa). Libera el cupo; después el admin REENVÍA la alerta
 * (`ResendCallUseCase`) para que otro lo tome. Quien fue cancelado no puede retomarlo.
 *
 * Usa el MISMO lock que aceptar: cancelar y aceptar sobre la misma alerta no se pisan.
 */
@Injectable()
export class CancelClaimUseCase {
  constructor(
    @Inject(ASSISTANCE_REPOSITORY) private readonly repo: AssistanceRepositoryPort,
    @Inject(DISTRIBUTED_LOCK) private readonly lock: DistributedLockPort,
  ) {}

  async execute(
    actor: AuthenticatedUser,
    callId: string,
    claimId: string,
    traceId = randomUUID(),
  ) {
    if (!(await this.repo.findCall(callId))) {
      throw new NotFoundError(`Alerta ${callId} no encontrada`);
    }

    const { value: result } = await this.lock.withLock(
      callLockKey(callId),
      () =>
        this.repo.cancelClaim(callId, claimId, actor.id, ({ call, claim }) => [
          assistanceEvent(
            'claim.cancelled',
            traceId,
            { roles: ['ADMIN'], userIds: [claim.userId] },
            { callId, claimId, userId: claim.userId, busId: call.busId, cancelledBy: actor.id },
          ),
          assistanceEvent('call.progress', traceId, { roles: ['ADMIN'] }, {
            callId,
            kind: call.kind,
            busId: call.busId,
            claimedCount: call.claimedCount,
            slots: call.slots,
          }),
        ]),
      { traceId },
    );

    if (!result.ok) {
      const message = CANCEL_FAILURE_MESSAGE[result.reason];
      if (result.reason === 'NOT_FOUND') throw new NotFoundError(message);
      throw new ConflictError(message, { reason: result.reason });
    }
    return { traceId, call: result.call, claim: result.claim };
  }
}
