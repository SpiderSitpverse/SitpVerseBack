export const API_RATE_LIMITER = Symbol('API_RATE_LIMITER');

/**
 * Puerto: límite de peticiones de la API por usuario (ventana de 1 minuto). Es una defensa contra abuso y contra un cliente
 * con errores que repite sin parar: pasado el límite lanza `TooManyRequestsError` (el cliente recibe 429 + `Retry-After`).
 * `key` identifica a quien se limita (`user:<id>`) y `bucket` el grupo de rutas (`api`, `upload`...).
 */
export interface ApiRateLimiterPort {
  assertAllowed(key: string, bucket: string, max: number): Promise<void>;
}
