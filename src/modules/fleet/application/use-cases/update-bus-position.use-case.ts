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
import { currentTraceIdOrNew } from '../../../../shared/telemetry-context';
import { Bus } from '../../domain/entities/bus.entity';

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

  /**
   * `target` es el id del bus o el bus YA cargado (el controller lo acaba de leer para autorizar al conductor: no se
   * vuelve a consultar; con 20 posiciones por segundo, cada consulta de menos cuenta).
   */
  async execute(target: string | Bus, latitude: number, longitude: number) {
    const bus = typeof target === 'string' ? await this.busRepository.findById(target) : target;
    if (!bus) {
      throw new NotFoundError(`Bus ${String(target)} no encontrado`);
    }

    bus.updatePosition(latitude, longitude);

    await this.busRepository.savePosition(bus);

    await this.positionPublisher.publish({
      busId: bus.id,
      plate: bus.plate,
      route: bus.route,
      status: bus.status,
      latitude,
      longitude,
      updatedAt: bus.updatedAt.toISOString(),
      traceId: currentTraceIdOrNew(),
      occurredAt: new Date().toISOString(),
    });

    return bus.toPersistence();
  }
}
