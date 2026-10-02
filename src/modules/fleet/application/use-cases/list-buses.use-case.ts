import { Inject, Injectable } from '@nestjs/common';
import {
  BUS_REPOSITORY,
  BusRepositoryPort,
} from '../../domain/ports/bus-repository.port';
import { BusStatus } from '../../domain/value-objects/bus-status.enum';

/**
 * HU-12: Visualizar ubicación de los buses.
 * HU-14: Filtrar (por estado) buses por estado.
 */
@Injectable()
export class ListBusesUseCase {
  constructor(
    @Inject(BUS_REPOSITORY) private readonly busRepository: BusRepositoryPort,
  ) {}

  /** `onlyDriverId`: un conductor solo ve su bus (lo fija el controller según el rol). */
  async execute(status?: BusStatus, onlyDriverId?: string) {
    const buses = await this.busRepository.findAll({ status, driverId: onlyDriverId });
    return buses.map((bus) => bus.toPersistence());
  }
}
