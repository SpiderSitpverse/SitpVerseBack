import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  BUS_REPOSITORY,
  BusRepositoryPort,
} from '../../domain/ports/bus-repository.port';
import { BusStatus } from '../../domain/value-objects/bus-status.enum';
import { OperativeHomeView } from '../dtos/operative-home.view';

/**
 *Home para usuarios operativos.
 */
@Injectable()
export class GetOperativeHomeUseCase {
  constructor(
    @Inject(BUS_REPOSITORY) private readonly busRepository: BusRepositoryPort,
  ) {}

  async execute(driver: string): Promise<OperativeHomeView> {
    const bus = await this.busRepository.findByDriver(driver);

    if (!bus) {
      throw new NotFoundException(
        `No hay un bus asignado al operativo "${driver}"`,
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