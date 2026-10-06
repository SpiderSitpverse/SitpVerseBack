import { Inject, Injectable } from '@nestjs/common';
import { InvalidInputError, NotFoundError } from '../../../../shared/domain/errors';
import { isUploadedImageUrl } from '../../../../shared/domain/file-storage.port';
import { Bus, BusDetails } from '../../domain/entities/bus.entity';
import { BUS_REPOSITORY, BusRepositoryPort } from '../../domain/ports/bus-repository.port';
import { DRIVER_DIRECTORY, DriverDirectoryPort } from '../../domain/ports/driver-directory.port';
import { BusStatus } from '../../domain/value-objects/bus-status.enum';

const PLATE = /^[A-Z0-9-]{3,12}$/;

/** La placa se guarda en mayúsculas y sin espacios, para que "tmx-001" y "TMX-001" sean el mismo bus. */
function normalizePlate(plate: string): string {
  const normalized = plate.trim().toUpperCase();
  if (!PLATE.test(normalized)) {
    throw new InvalidInputError('La placa debe tener de 3 a 12 caracteres: letras, números o guion');
  }
  return normalized;
}

/** Solo se aceptan fotos que subió este mismo back (nada de URLs externas ni rutas arbitrarias). */
function assertUploadedPhoto(photoUrl: string | null | undefined) {
  if (typeof photoUrl === 'string' && !isUploadedImageUrl(photoUrl)) {
    throw new InvalidInputError('La foto debe ser una imagen subida con POST /files/images');
  }
}

function clean(details: BusDetails): BusDetails {
  assertUploadedPhoto(details.photoUrl);
  return {
    ...details,
    plate: details.plate === undefined ? undefined : normalizePlate(details.plate),
    route: details.route?.trim(),
  };
}

/** Registro de flota: da de alta un bus nuevo con su ficha. */
@Injectable()
export class CreateBusUseCase {
  constructor(@Inject(BUS_REPOSITORY) private readonly buses: BusRepositoryPort) {}

  async execute(data: BusDetails & { plate: string; route: string }) {
    const bus = await this.buses.create(clean(data) as BusDetails & { plate: string; route: string });
    return bus.toPersistence();
  }
}

/** Registro de flota: edita la ficha de un bus (modelo, año, operador, capacidad, referencia...). */
@Injectable()
export class UpdateBusDetailsUseCase {
  constructor(@Inject(BUS_REPOSITORY) private readonly buses: BusRepositoryPort) {}

  async execute(busId: string, details: BusDetails) {
    if (!(await this.buses.findById(busId))) throw new NotFoundError(`Bus ${busId} no encontrado`);
    const bus = await this.buses.updateDetails(busId, clean(details));
    return bus.toPersistence();
  }
}

/** El administrador asigna (o quita, con `null`) el conductor de un bus. */
@Injectable()
export class AssignDriverUseCase {
  constructor(
    @Inject(BUS_REPOSITORY) private readonly buses: BusRepositoryPort,
    @Inject(DRIVER_DIRECTORY) private readonly drivers: DriverDirectoryPort,
  ) {}

  async execute(busId: string, driverId: string | null) {
    if (!(await this.buses.findById(busId))) throw new NotFoundError(`Bus ${busId} no encontrado`);
    if (driverId !== null && !(await this.drivers.findActiveDriver(driverId))) {
      throw new InvalidInputError('El usuario indicado no existe, está inactivo o no es conductor');
    }
    // Si el conductor ya tiene otro bus, el UNIQUE de la base de datos lo rechaza con 409.
    const bus: Bus = await this.buses.assignDriver(busId, driverId);
    return bus.toPersistence();
  }
}

/** Resumen de la flota para el panel del administrador. */
@Injectable()
export class GetFleetSummaryUseCase {
  constructor(@Inject(BUS_REPOSITORY) private readonly buses: BusRepositoryPort) {}

  async execute() {
    const byStatus = await this.buses.countByStatus();
    const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0);
    return {
      total,
      inService: byStatus[BusStatus.IN_SERVICE],
      idle: byStatus[BusStatus.IDLE],
      finished: byStatus[BusStatus.FINISHED],
    };
  }
}
