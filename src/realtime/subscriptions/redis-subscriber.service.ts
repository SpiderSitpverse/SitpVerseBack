import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_SUBSCRIBER_CLIENT } from '../../shared/infrastructure/redis.provider';
import { FLEET_POSITIONS_CHANNEL } from '../../modules/fleet/infrastructure/redis/redis-position-publisher';
import { FleetGateway } from '../websocket/fleet.gateway';
import { BusPositionEvent } from '../../modules/fleet/domain/ports/position-publisher.port';

/**
 * Puente Redis -> WebSocket.
 *
 * Por qué existe esta pieza (y no publicar directo desde el caso de uso al Gateway):
 * si el día de mañana corren 2+ instancias del backend detrás de un balanceador,
 * el cliente WebSocket puede estar conectado a la instancia B mientras el POST que
 * actualiza la posición llegó a la instancia A. Redis Pub/Sub es lo que permite que
 * TODAS las instancias se enteren y reenvíen a SUS clientes conectados. Así se
 * resuelve la concurrencia entre múltiples buses y múltiples clientes/instancias.
 */
@Injectable()
export class RedisSubscriberService implements OnModuleInit {
  private readonly logger = new Logger(RedisSubscriberService.name);

  constructor(
    @Inject(REDIS_SUBSCRIBER_CLIENT) private readonly redisSubscriber: Redis,
    private readonly fleetGateway: FleetGateway,
  ) {}

  async onModuleInit() {
    await this.redisSubscriber.subscribe(FLEET_POSITIONS_CHANNEL);

    this.redisSubscriber.on('message', (channel: string, message: string) => {
      if (channel !== FLEET_POSITIONS_CHANNEL) return;

      try {
        const event: BusPositionEvent = JSON.parse(message);
        this.fleetGateway.broadcastPositionUpdate(event);
      } catch (err) {
        this.logger.error(`Evento inválido en ${channel}: ${err}`);
      }
    });

    this.logger.log(`Suscrito a canal Redis "${FLEET_POSITIONS_CHANNEL}"`);
  }
}
