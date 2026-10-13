import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ConflictError, NotFoundError } from '../../../../shared/domain/errors';
import {
  ASSISTANCE_REPOSITORY,
  AssistanceRepositoryPort,
} from '../../domain/ports/assistance-repository.port';
import { assistanceEvent } from '../assistance-event.factory';

const FAILURE_MESSAGE = {
  CLAIMED:
    'Ya hay alguien atendiendo este incidente. Si lo eliminas se cancelan sus aceptaciones y no cobran los puntos.',
  TOW_ACTIVE: 'Este incidente tiene una grúa en servicio: termina el servicio de grúa antes de eliminarlo.',
  ROUTE_ACTIVE:
    'Este incidente tiene una ruta alternativa asignada o aceptada por un conductor. Si lo eliminas, ese conductor pierde el desvío.',
} as const;

/**
 * El administrador elimina un incidente reportado por error (o que ya no importa).
 *
 * Solo si NADIE lo ha atendido: sus alertas sin aceptaciones se borran con él. Si alguna ya tiene
 * conductores o mecánico asignados, o está terminada (hay trabajo y puntos de por medio), o hay una grúa en
 * servicio o una ruta alternativa asignada/aceptada, se rechaza con 409: primero hay que cancelar o terminar eso.
 */
@Injectable()
export class DeleteIncidentUseCase {
  constructor(@Inject(ASSISTANCE_REPOSITORY) private readonly repo: AssistanceRepositoryPort) {}

  /** `force`: eliminarlo aunque alguien lo esté atendiendo (se cancelan sus aceptaciones, sin puntos). */
  async execute(incidentId: string, options: { force?: boolean } = {}, traceId = randomUUID()) {
    const result = await this.repo.deleteIncident(
      incidentId,
      (deleted) => [
        // Admin, conductores y mecánicos refrescan sus listas (las alertas de apoyo y las solicitudes de
        // reparación de ese incidente desaparecen).
        assistanceEvent('incident.deleted', traceId, { roles: ['ADMIN', 'DRIVER', 'MECHANICAL'] }, {
          incidentId: deleted.id,
          busId: deleted.busId,
          // A quienes se les canceló su aceptación o su desvío: el front les avisa que ya no tienen que ir.
          affectedUserIds: deleted.affectedUserIds,
        }),
      ],
      options,
    );
    if (!result.ok) {
      if (result.reason === 'NOT_FOUND') throw new NotFoundError(`Incidente ${incidentId} no encontrado`);
      throw new ConflictError(FAILURE_MESSAGE[result.reason], { reason: result.reason });
    }
    return { deleted: true, removedCalls: result.removedCalls };
  }
}
