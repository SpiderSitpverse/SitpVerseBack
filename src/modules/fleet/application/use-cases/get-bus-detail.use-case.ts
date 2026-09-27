import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  BUS_REPOSITORY,
  BusRepositoryPort,
} from '../../domain/ports/bus-repository.port';

/** HU-13: Consultar información detallada de un bus seleccionado. */
@Injectable()
export class GetBusDetailUseCase {
  constructor(
    @Inject(BUS_REPOSITORY) private readonly busRepository: BusRepositoryPort,
  ) {}

  async execute(busId: string) {
    const bus = await this.busRepository.findById(busId);
    if (!bus) {
      throw new NotFoundException(`Bus ${busId} no encontrado`);
    }
    return bus.toPersistence();
  }
}
