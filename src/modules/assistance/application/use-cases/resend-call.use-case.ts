import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ConflictError, NotFoundError } from '../../../../shared/domain/errors';
import {
  ASSISTANCE_REPOSITORY,
  AssistanceRepositoryPort,
} from '../../domain/ports/assistance-repository.port';
import { ROLE_FOR_KIND } from '../../domain/models/assistance.models';
import { assistanceEvent } from '../assistance-event.factory';

/**
 * El admin reenvía la alerta (tras cancelar una aceptación vencida) a quienes corresponde,
 * indicando cuántos cupos quedan libres. Solo tiene sentido si queda al menos un cupo.
 * El evento es durable (outbox): si Redis estuviera caído, se entrega al volver.
 */
@Injectable()
export class ResendCallUseCase {
  constructor(
    @Inject(ASSISTANCE_REPOSITORY) private readonly repo: AssistanceRepositoryPort,
  ) {}

  async execute(callId: string, traceId = randomUUID()) {
    const call = await this.repo.findCall(callId);
    if (!call) throw new NotFoundError(`Alerta ${callId} no encontrada`);

    const remaining = call.slots - call.claimedCount;
    if (call.status !== 'OPEN' || remaining <= 0) {
      throw new ConflictError('La alerta no tiene cupos libres para reenviar', {
        status: call.status,
      });
    }

    await this.repo.enqueueEvents([
      assistanceEvent('call.opened', traceId, { roles: [ROLE_FOR_KIND[call.kind]] }, {
        callId: call.id,
        kind: call.kind,
        busId: call.busId,
        slots: call.slots,
        remainingSlots: remaining,
        rewardPoints: call.rewardPoints,
        description: call.description,
        resent: true,
      }),
    ]);
    return { traceId, callId: call.id, remainingSlots: remaining };
  }
}
