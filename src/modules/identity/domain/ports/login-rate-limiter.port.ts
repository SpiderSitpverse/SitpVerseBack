export const LOGIN_RATE_LIMITER = Symbol('LOGIN_RATE_LIMITER');

/**
 * Puerto: límite de peticiones de inicio de sesión por IP (ventana de 1 minuto, 10 por defecto).
 * Pasado el límite lanza `TooManyRequestsError` con el tiempo de espera (el cliente recibe 429 + `Retry-After`).
 */
export interface LoginRateLimiterPort {
  assertAllowed(ip: string): Promise<void>;
}
