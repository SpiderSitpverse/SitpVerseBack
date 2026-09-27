import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  BUS_REPOSITORY,
  BusRepositoryPort,
} from '../../domain/ports/bus-repository.port';
import {
  POSITION_PUBLISHER,
  PositionPublisherPort,
} from '../../domain/ports/position-publisher.port';

/**
 * HU-49 (parte 2): Actualizar posición en tiempo real.
 *
 * Este es el caso de uso "core" del sprint: cada vez que se llama,
 * 1) aplica la regla de negocio en la entidad (solo si está IN_SERVICE),
 * 2) persiste el nuevo estado + guarda historial (trazabilidad),
 * 3) publica el evento a Redis, que el Realtime Gateway reenvía por WebSocket.
 *
 * El caso de uso NO conoce Socket.io ni Redis directamente: solo conoce los ports.
 */
@Injectable()
export class UpdateBusPositionUseCase {
  constructor(
    @Inject(BUS_REPOSITORY) private readonly busRepository: BusRepositoryPort,
    @Inject(POSITION_PUBLISHER)
    private readonly positionPublisher: PositionPublisherPort,
  ) {}

  async execute(busId: string, latitude: number, longitude: number) {
    const bus = await this.busRepository.findById(busId);
    if (!bus) {
      throw new NotFoundException(`Bus ${busId} no encontrado`);
    }

    bus.updatePosition(latitude, longitude);

    await this.busRepository.save(bus);
    await this.busRepository.appendPositionHistory(busId, latitude, longitude);

    await this.positionPublisher.publish({
      busId: bus.id,
      plate: bus.plate,
      route: bus.route,
      status: bus.status,
      latitude,
      longitude,
      updatedAt: bus.updatedAt.toISOString(),
    });

    return bus.toPersistence();
  }
}
