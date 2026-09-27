import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_PUBLISHER_CLIENT } from '../../../../shared/infrastructure/redis.provider';
import {
  BusPositionEvent,
  PositionPublisherPort,
} from '../../domain/ports/position-publisher.port';

export const FLEET_POSITIONS_CHANNEL = 'fleet:positions';

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
    await this.redis.publish(FLEET_POSITIONS_CHANNEL, JSON.stringify(event));
  }
}
