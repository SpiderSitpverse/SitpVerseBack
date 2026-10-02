import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../../shared/domain/errors';
import {
  BUS_REPOSITORY,
  BusRepositoryPort,
} from '../../domain/ports/bus-repository.port';
import { BusStatus } from '../../domain/value-objects/bus-status.enum';
import { OperativeHomeView } from '../dtos/operative-home.view';

/**
 * HU-11: Home para usuarios operativos.
 * El conductor autenticado ve SU bus (relación `driverId`).
 */
@Injectable()
export class GetOperativeHomeUseCase {
  constructor(
    @Inject(BUS_REPOSITORY) private readonly busRepository: BusRepositoryPort,
  ) {}

  async execute(driverId: string): Promise<OperativeHomeView> {
    const bus = await this.busRepository.findByDriverId(driverId);

    if (!bus) {
      throw new NotFoundError(
        'No tienes un bus asignado',
      );
    }

    return {
      busId: bus.id,
      plate: bus.plate,
      route: bus.route,
      status: bus.status,
      hasActiveTrip: bus.status === BusStatus.IN_SERVICE,
      latitude: bus.latitude,
      longitude: bus.longitude,
      updatedAt: bus.updatedAt.toISOString(),
    };
  }
}
