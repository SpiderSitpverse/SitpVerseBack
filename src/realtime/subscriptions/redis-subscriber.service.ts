import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CHANNELS } from '../../shared/contracts/realtime.contract';
import { REDIS_SUBSCRIBER_CLIENT } from '../../shared/infrastructure/redis.provider';
import type { BusPositionEvent } from '../../modules/fleet/public';
import { RealtimeGateway } from '../websocket/realtime.gateway';

/**
 * Puente Redis Pub/Sub → WebSocket para eventos EFÍMEROS (posición GPS de los buses).
 *
 * Aquí Pub/Sub es lo correcto: llegan decenas por segundo y perder uno no importa, porque
 * el siguiente lo reemplaza. Las alertas, que no pueden perderse, NO usan este camino:
 * viajan por el outbox + Redis Streams (ver `RedisStreamConsumer`).
 *
 * Con 2+ instancias del backend, todas están suscritas y cada una reenvía el evento a SUS
 * clientes (el cliente puede estar conectado a una instancia distinta de la que lo originó).
 */
@Injectable()
export class RedisSubscriberService implements OnModuleInit {
  private readonly logger = new Logger(RedisSubscriberService.name);

  constructor(
    @Inject(REDIS_SUBSCRIBER_CLIENT) private readonly redis: Redis,
    private readonly gateway: RealtimeGateway,
  ) {}

  async onModuleInit() {
    await this.redis.subscribe(REDIS_CHANNELS.FLEET_POSITIONS);
    this.redis.on('message', (channel: string, message: string) => {
      if (channel !== REDIS_CHANNELS.FLEET_POSITIONS) return;
      try {
        this.gateway.broadcastPositionUpdate(JSON.parse(message) as BusPositionEvent);
      } catch (err) {
        this.logger.error(`Evento inválido en ${channel}: ${err}`);
      }
    });
    this.logger.log(`Suscrito a Pub/Sub: ${REDIS_CHANNELS.FLEET_POSITIONS}`);
  }
}
