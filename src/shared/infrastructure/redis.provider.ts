import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';
import { buildRedisOptions, readRedisSettings } from './redis-connection';

export const REDIS_PUBLISHER_CLIENT = Symbol('REDIS_PUBLISHER_CLIENT');
export const REDIS_SUBSCRIBER_CLIENT = Symbol('REDIS_SUBSCRIBER_CLIENT');
export const REDIS_STREAM_CLIENT = Symbol('REDIS_STREAM_CLIENT');
export const REDIS_RELAY_CLIENT = Symbol('REDIS_RELAY_CLIENT');

const logger = new Logger('Redis');

/**
 * ioredis exige conexiones SEPARADAS para publicar y para suscribirse: una conexión en
 * modo "subscribe" no admite otros comandos.
 */
function buildClient(
  name: string,
  config: ConfigService,
  options: RedisOptions = {},
): Redis {
  // Host, puerto, contraseña y TLS salen de las variables de entorno (ver redis-connection.ts).
  const client = new Redis(
    buildRedisOptions(readRedisSettings((key) => config.get<string>(key)), options),
  );
  // Sin listener, un error de conexión tumba el proceso con "Unhandled error event".
  client.on('error', (err) => logger.error(`[${name}] ${err.message}`));
  return client;
}

export const RedisPublisherProvider: Provider = {
  provide: REDIS_PUBLISHER_CLIENT,
  useFactory: (config: ConfigService) => buildClient('publisher', config),
  inject: [ConfigService],
};

export const RedisSubscriberProvider: Provider = {
  provide: REDIS_SUBSCRIBER_CLIENT,
  useFactory: (config: ConfigService) =>
    // enableReadyCheck:false es obligatorio en el suscriptor: el chequeo envía `INFO`, y si
    // la conexión ya entró en modo subscribe falla y se pierde la suscripción (carrera de arranque).
    buildClient('subscriber', config, { enableReadyCheck: false }),
  inject: [ConfigService],
};

/** Conexión dedicada a `XREAD BLOCK` (lecturas bloqueantes de Streams): no debe compartirse. */
export const RedisStreamProvider: Provider = {
  provide: REDIS_STREAM_CLIENT,
  useFactory: (config: ConfigService) => buildClient('stream', config),
  inject: [ConfigService],
};

/**
 * Conexión del relay del outbox. `enableOfflineQueue: false`: si Redis no está, el comando
 * FALLA DE INMEDIATO en vez de quedar en una cola oculta de ioredis. Sin esto, cada reintento
 * del relay se acumularía en esa cola y, al volver Redis, se ejecutarían todos (duplicados).
 */
export const RedisRelayProvider: Provider = {
  provide: REDIS_RELAY_CLIENT,
  useFactory: (config: ConfigService) =>
    buildClient('relay', config, { enableOfflineQueue: false, maxRetriesPerRequest: 1 }),
  inject: [ConfigService],
};
