import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ConflictError, NotFoundError } from '../../../../shared/domain/errors';
import {
  ASSISTANCE_REPOSITORY,
  AssistanceRepositoryPort,
} from '../../domain/ports/assistance-repository.port';
import { assistanceEvent } from '../assistance-event.factory';

/**
 * El administrador elimina un incidente reportado por error (o que ya no importa).
 *
 * Solo si NADIE lo ha atendido: sus alertas sin aceptaciones se borran con él. Si alguna ya tiene
 * conductores o mecánico asignados, o está terminada (hay trabajo y puntos de por medio), se rechaza con 409:
 * primero se cancelan las aceptaciones.
 */
@Injectable()
export class DeleteIncidentUseCase {
  constructor(@Inject(ASSISTANCE_REPOSITORY) private readonly repo: AssistanceRepositoryPort) {}

  async execute(incidentId: string, traceId = randomUUID()) {
    const result = await this.repo.deleteIncident(incidentId, (deleted) => [
      // Admin, conductores y mecánicos refrescan sus listas (las alertas de apoyo y las solicitudes de
      // reparación sin atender de ese incidente desaparecen).
      assistanceEvent('incident.deleted', traceId, { roles: ['ADMIN', 'DRIVER', 'MECHANICAL'] }, {
        incidentId: deleted.id,
        busId: deleted.busId,
      }),
    ]);
    if (!result.ok) {
      if (result.reason === 'NOT_FOUND') throw new NotFoundError(`Incidente ${incidentId} no encontrado`);
      throw new ConflictError(
        'Este incidente ya tiene una atención en curso o terminada: cancela las aceptaciones antes de eliminarlo',
        { reason: result.reason },
      );
    }
    return { deleted: true, removedCalls: result.removedCalls };
  }
}
