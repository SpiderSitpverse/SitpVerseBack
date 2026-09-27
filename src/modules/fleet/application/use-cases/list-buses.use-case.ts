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

  async execute(status?: BusStatus) {
    const buses = await this.busRepository.findAll(
      status ? { status } : undefined,
    );
    return buses.map((bus) => bus.toPersistence());
  }
}
