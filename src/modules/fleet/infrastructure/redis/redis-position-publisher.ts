import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CHANNELS } from '../../../../shared/contracts/realtime.contract';
import { logEvent } from '../../../../shared/infrastructure/structured-log';
import { REDIS_PUBLISHER_CLIENT } from '../../../../shared/infrastructure/redis.provider';
import {
  BusPositionEvent,
  PositionPublisherPort,
} from '../../domain/ports/position-publisher.port';

/**
 * Adapter (driven adapter): implementa el puerto de publicación usando Redis Pub/Sub.
 * Publicar acá es lo que permite que, si en el futuro hay más de una instancia
 * del backend corriendo, TODAS enteren a sus clientes WebSocket conectados
 * (no solo la instancia que recibió el POST) — esto es lo que da soporte a
 * concurrencia real más allá de un solo proceso Node.
 */
@Injectable()
export class RedisPositionPublisher implements PositionPublisherPort {
  constructor(
    @Inject(REDIS_PUBLISHER_CLIENT) private readonly redis: Redis,
  ) {}

  async publish(event: BusPositionEvent): Promise<void> {
    try {
      await this.redis.publish(REDIS_CHANNELS.FLEET_POSITIONS, JSON.stringify(event));
    } catch (err) {
      // La posición ya quedó guardada; perder UN evento no debe hacer fallar la actualización.
      logEvent('error', 'event.publish_failed', {
        event: 'fleet.position',
        bus: event.plate,
        severity: 'ERROR',
        error: String(err),
      });
    }
  }
}
