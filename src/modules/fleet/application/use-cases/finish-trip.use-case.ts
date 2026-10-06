import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../../shared/domain/errors';
import {
  BUS_REPOSITORY,
  BusRepositoryPort,
} from '../../domain/ports/bus-repository.port';
import {
  POSITION_PUBLISHER,
  PositionPublisherPort,
} from '../../domain/ports/position-publisher.port';

/** HU-51: Finalizar servicio/viaje del bus. */
@Injectable()
export class FinishTripUseCase {
  constructor(
    @Inject(BUS_REPOSITORY) private readonly busRepository: BusRepositoryPort,
    @Inject(POSITION_PUBLISHER)
    private readonly positionPublisher: PositionPublisherPort,
  ) {}

  async execute(busId: string) {
    const bus = await this.busRepository.findById(busId);
    if (!bus) {
      throw new NotFoundError(`Bus ${busId} no encontrado`);
    }

    bus.finishTrip();
    await this.busRepository.save(bus);

    // Avisamos al frontend en tiempo real de que el bus dejó de estar en servicio,
    // así el mapa lo puede sacar de la vista o marcarlo como finalizado.
    await this.positionPublisher.publish({
      busId: bus.id,
      plate: bus.plate,
      route: bus.route,
      status: bus.status,
      latitude: bus.latitude ?? 0,
      longitude: bus.longitude ?? 0,
      updatedAt: bus.updatedAt.toISOString(),
    });

    return bus.toPersistence();
  }
}
