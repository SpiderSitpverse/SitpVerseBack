import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  BUS_REPOSITORY,
  BusRepositoryPort,
} from '../../domain/ports/bus-repository.port';

/** HU-49 (parte 1): Reportar inicio de viaje. */
@Injectable()
export class StartTripUseCase {
  constructor(
    @Inject(BUS_REPOSITORY) private readonly busRepository: BusRepositoryPort,
  ) {}

  async execute(busId: string) {
    const bus = await this.busRepository.findById(busId);
    if (!bus) {
      throw new NotFoundException(`Bus ${busId} no encontrado`);
    }

    bus.startTrip(); // regla de negocio vive en la entidad
    await this.busRepository.save(bus);

    return bus.toPersistence();
  }
}
