import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { NotFoundError } from '../../../../shared/domain/errors';
import { AuthenticatedUser } from '../../../identity/public';
import {
  ASSISTANCE_REPOSITORY,
  AssistanceRepositoryPort,
} from '../../domain/ports/assistance-repository.port';
import { BUS_DIRECTORY, BusDirectoryPort } from '../../domain/ports/bus-directory.port';
import { assistanceEvent } from '../assistance-event.factory';

const DEFAULT_REPAIR_BONUS = 50;

/**
 * Uso 2: a un bus se le genera un fallo → alerta a los mecánicos con UN solo cupo;
 * el primero que acepte se queda la reparación y cobra el bono.
 *
 * Hoy lo dispara un conductor o un admin. Cuando exista la telemetría real de
 * TransMilenio, el adapter que detecte la falla llama a este mismo caso de uso.
 *
 * Varios reportes del mismo bus a la vez (conductor + admin, doble clic) producen UNA
 * sola alerta abierta: lo garantiza un índice único parcial en Postgres.
 */
@Injectable()
export class ReportBusFaultUseCase {
  constructor(
    @Inject(ASSISTANCE_REPOSITORY) private readonly repo: AssistanceRepositoryPort,
    @Inject(BUS_DIRECTORY) private readonly buses: BusDirectoryPort,
    private readonly config: ConfigService,
  ) {}

  async execute(
    actor: AuthenticatedUser,
    data: { busId: string; description?: string; rewardPoints?: number },
    traceId = randomUUID(),
  ) {
    if (!(await this.buses.exists(data.busId))) {
      throw new NotFoundError(`Bus ${data.busId} no encontrado`);
    }

    // Solo la alerta realmente nueva genera evento: los mecánicos no reciben duplicados.
    const { call, created } = await this.repo.createCall(
      {
        kind: 'REPAIR',
        busId: data.busId,
        slots: 1,
        rewardPoints:
          data.rewardPoints ??
          Number(this.config.get('REPAIR_BONUS_POINTS', DEFAULT_REPAIR_BONUS)),
        createdById: actor.id,
        description: data.description,
      },
      (newCall) => [
        assistanceEvent('call.opened', traceId, { roles: ['MECHANICAL'] }, {
          callId: newCall.id,
          kind: newCall.kind,
          busId: newCall.busId,
          slots: newCall.slots,
          remainingSlots: newCall.slots,
          rewardPoints: newCall.rewardPoints,
          description: newCall.description,
        }),
      ],
    );
    return { call, duplicate: !created };
  }
}
