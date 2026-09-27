import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_PUBLISHER_CLIENT = Symbol('REDIS_PUBLISHER_CLIENT');
export const REDIS_SUBSCRIBER_CLIENT = Symbol('REDIS_SUBSCRIBER_CLIENT');

/**
 * ioredis exige conexiones separadas para publicar y para suscribirse
 * (una conexión en modo "subscribe" no puede usarse para otros comandos).
 */
function buildClient(config: ConfigService): Redis {
  return new Redis({
    host: config.get<string>('REDIS_HOST', 'localhost'),
    port: config.get<number>('REDIS_PORT', 6379),
  });
}

export const RedisPublisherProvider: Provider = {
  provide: REDIS_PUBLISHER_CLIENT,
  useFactory: (config: ConfigService) => buildClient(config),
  inject: [ConfigService],
};

export const RedisSubscriberProvider: Provider = {
  provide: REDIS_SUBSCRIBER_CLIENT,
  useFactory: (config: ConfigService) => buildClient(config),
  inject: [ConfigService],
};
