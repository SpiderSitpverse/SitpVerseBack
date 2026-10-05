import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ConflictError, NotFoundError } from '../../../../shared/domain/errors';
import { AuthenticatedUser } from '../../../identity/public';
import {
  ASSISTANCE_REPOSITORY,
  AssistanceRepositoryPort,
} from '../../domain/ports/assistance-repository.port';
import { assertCanComplete } from '../../domain/assistance.policy';
import { assistanceEvent } from '../assistance-event.factory';

/**
 * Cierra el servicio y acredita los puntos (recompensa de apoyo / bono por bus reparado).
 *
 * El cierre es atómico en BD (`repo.complete` solo cambia el estado UNA vez) y el libro de
 * puntos es único por (usuario, alerta): aunque lleguen varios "completar" a la vez, uno
 * gana y los puntos se pagan una sola vez. Solo cobran las aceptaciones ACTIVAS.
 */
@Injectable()
export class CompleteCallUseCase {
  constructor(
    @Inject(ASSISTANCE_REPOSITORY) private readonly repo: AssistanceRepositoryPort,
  ) {}

  async execute(actor: AuthenticatedUser, callId: string, traceId = randomUUID()) {
    const call = await this.repo.findCall(callId);
    if (!call) throw new NotFoundError(`Alerta ${callId} no encontrada`);

    const activeClaims = (await this.repo.listClaims([callId])).filter((c) => c.status === 'ACTIVE');
    if (activeClaims.length === 0) {
      throw new ConflictError('Nadie tiene una aceptación activa en esta alerta');
    }
    assertCanComplete(call, actor, activeClaims);

    const done = await this.repo.complete(callId, ({ awardedUserIds }) => [
      assistanceEvent(
        'call.completed',
        traceId,
        { roles: ['ADMIN'], userIds: awardedUserIds },
        {
          callId,
          kind: call.kind,
          busId: call.busId,
          rewardPoints: call.rewardPoints,
          awardedUserIds,
        },
      ),
    ]);
    if (!done) throw new ConflictError('La alerta ya fue completada');

    return {
      traceId,
      call: done.call,
      awardedUserIds: done.awardedUserIds,
      pointsEach: call.rewardPoints,
    };
  }
}
