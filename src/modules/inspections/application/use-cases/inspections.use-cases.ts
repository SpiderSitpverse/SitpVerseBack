import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../../shared/domain/errors';
import { AuthenticatedUser } from '../../../identity/public';
import {
  INSPECTION_BUS_DIRECTORY,
  InspectionBusDirectoryPort,
} from '../../domain/ports/bus-directory.port';
import {
  INSPECTION_REPOSITORY,
  InspectionRepositoryPort,
} from '../../domain/ports/inspection-repository.port';
import { InspectionFilter } from '../../domain/models/inspection.models';
import {
  assertCanRegister,
  assertCanView,
  assertValidPhotos,
  assertValidText,
} from '../../domain/inspection.policy';

/**
 * HU-16 / HU-18: el conductor registra la inspección previa de SU bus (nota, comentario y fotos).
 * Queda inmutable y con quién la hizo y cuándo: sirve para saber si un daño ya existía.
 */
@Injectable()
export class CreateInspectionUseCase {
  constructor(
    @Inject(INSPECTION_REPOSITORY) private readonly repo: InspectionRepositoryPort,
    @Inject(INSPECTION_BUS_DIRECTORY) private readonly buses: InspectionBusDirectoryPort,
  ) {}

  async execute(
    actor: AuthenticatedUser,
    data: { busId: string; note: string; comment?: string; photos?: string[] },
  ) {
    if (!(await this.buses.exists(data.busId))) throw new NotFoundError(`Bus ${data.busId} no encontrado`);
    assertCanRegister(actor, data.busId, await this.buses.findBusIdOfDriver(actor.id));

    const photos = data.photos ?? [];
    assertValidText(data.note);
    assertValidPhotos(photos);

    return this.repo.create({
      busId: data.busId,
      inspectorId: actor.id,
      inspectorName: actor.name,
      inspectorRole: actor.role,
      note: data.note.trim(),
      comment: data.comment?.trim() || undefined,
      photos,
    });
  }
}

/** La inspección más reciente de un bus (la que muestra el panel al abrir el bus). */
@Injectable()
export class GetLatestInspectionUseCase {
  constructor(
    @Inject(INSPECTION_REPOSITORY) private readonly repo: InspectionRepositoryPort,
    @Inject(INSPECTION_BUS_DIRECTORY) private readonly buses: InspectionBusDirectoryPort,
  ) {}

  async execute(actor: AuthenticatedUser, busId: string) {
    assertCanView(actor, busId, await this.buses.findBusIdOfDriver(actor.id));
    const latest = await this.repo.findLatestByBus(busId);
    if (!latest) throw new NotFoundError('Este bus todavía no tiene inspecciones');
    return latest;
  }
}

/** HU-19 / HU-20: historial de inspecciones con filtros por bus, fecha y quién inspeccionó. */
@Injectable()
export class ListInspectionsUseCase {
  constructor(@Inject(INSPECTION_REPOSITORY) private readonly repo: InspectionRepositoryPort) {}

  execute(filter: InspectionFilter) {
    return this.repo.list(filter);
  }
}
