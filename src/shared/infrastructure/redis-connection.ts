import { RedisOptions } from 'ioredis';

/** Lo que se lee de la configuración (variables de entorno) para conectarse a Redis. */
export interface RedisSettings {
  host: string;
  port: number;
  /** Clave de acceso (Azure Managed Redis la exige; en local no hay). */
  password?: string;
  username?: string;
  /** Conexión cifrada. Obligatoria en Azure; en local (docker) debe ir apagada. */
  tls: boolean;
}

type Read = (key: string, fallback?: string) => string | undefined;

const isTrue = (value: string | undefined) => value?.trim().toLowerCase() === 'true';

/** Lee los ajustes de Redis de la configuración. Los valores vacíos se tratan como "no definido". */
export function readRedisSettings(get: Read): RedisSettings {
  const text = (key: string) => get(key)?.trim() || undefined;
  return {
    host: text('REDIS_HOST') ?? 'localhost',
    port: Number(text('REDIS_PORT') ?? 6379),
    password: text('REDIS_PASSWORD'),
    username: text('REDIS_USERNAME'),
    tls: isTrue(get('REDIS_TLS')),
  };
}

/**
 * Opciones de ioredis a partir de los ajustes. Con `tls` se cifra la conexión y se verifica el
 * certificado del servidor (por nombre de host): así nadie puede interponerse entre el backend y Redis.
 */
export function buildRedisOptions(settings: RedisSettings, overrides: RedisOptions = {}): RedisOptions {
  return {
    host: settings.host,
    port: settings.port,
    ...(settings.username ? { username: settings.username } : {}),
    ...(settings.password ? { password: settings.password } : {}),
    ...(settings.tls ? { tls: { servername: settings.host } } : {}),
    ...overrides,
  };
}
