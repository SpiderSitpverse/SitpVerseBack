import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ConflictError, NotFoundError } from '../../../../shared/domain/errors';
import { AuthenticatedUser } from '../../../identity/public';
import {
  ASSISTANCE_REPOSITORY,
  AssistanceRepositoryPort,
} from '../../domain/ports/assistance-repository.port';
import { assistanceEvent } from '../assistance-event.factory';

/**
 * Uso 1 · paso 2: el admin lanza la alerta de apoyo a los conductores indicando
 * cuántos buses hacen falta (`slots`) y la recompensa.
 *
 * Si dos admins lo intentan a la vez sobre el mismo incidente, el repositorio lo
 * resuelve con un compare-and-set (REPORTED → HELP_REQUESTED): solo uno crea la alerta.
 */
@Injectable()
export class RequestDriverSupportUseCase {
  constructor(
    @Inject(ASSISTANCE_REPOSITORY) private readonly repo: AssistanceRepositoryPort,
  ) {}

  async execute(
    actor: AuthenticatedUser,
    incidentId: string,
    data: { slots: number; rewardPoints: number },
    traceId = randomUUID(),
  ) {
    const incident = await this.repo.findIncident(incidentId);
    if (!incident) throw new NotFoundError(`Incidente ${incidentId} no encontrado`);

    const call = await this.repo.createSupportCallForIncident(
      incidentId,
      {
        kind: 'DRIVER_SUPPORT',
        busId: incident.busId,
        slots: data.slots,
        rewardPoints: data.rewardPoints,
        createdById: actor.id,
        description: incident.description ?? incident.type,
      },
      (created) => [
        assistanceEvent('call.opened', traceId, { roles: ['DRIVER'] }, {
          callId: created.id,
          kind: created.kind,
          busId: created.busId,
          slots: created.slots,
          remainingSlots: created.slots,
          rewardPoints: created.rewardPoints,
          description: created.description,
          reportedById: incident.reportedById,
        }),
      ],
    );
    if (!call) throw new ConflictError('Este incidente ya tiene una alerta de apoyo');
    return call;
  }
}
