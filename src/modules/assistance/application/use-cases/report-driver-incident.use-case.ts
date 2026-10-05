import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NotFoundError } from '../../../../shared/domain/errors';
import { AuthenticatedUser } from '../../../identity/public';
import {
  ASSISTANCE_REPOSITORY,
  AssistanceRepositoryPort,
} from '../../domain/ports/assistance-repository.port';
import { BUS_DIRECTORY, BusDirectoryPort } from '../../domain/ports/bus-directory.port';
import { assistanceEvent } from '../assistance-event.factory';

/** Uso 1 · paso 1: el conductor reporta un imprevisto y administración recibe la alerta. */
@Injectable()
export class ReportDriverIncidentUseCase {
  constructor(
    @Inject(ASSISTANCE_REPOSITORY) private readonly repo: AssistanceRepositoryPort,
    @Inject(BUS_DIRECTORY) private readonly buses: BusDirectoryPort,
  ) {}

  async execute(
    actor: AuthenticatedUser,
    data: { busId: string; type: string; description?: string },
    traceId = randomUUID(),
  ) {
    if (!(await this.buses.exists(data.busId))) {
      throw new NotFoundError(`Bus ${data.busId} no encontrado`);
    }
    return this.repo.createIncident({ ...data, reportedById: actor.id }, (incident) => [
      assistanceEvent('incident.reported', traceId, { roles: ['ADMIN'] }, {
        incidentId: incident.id,
        busId: incident.busId,
        type: incident.type,
        description: incident.description,
        reportedBy: { id: actor.id, name: actor.name },
      }),
    ]);
  }
}
