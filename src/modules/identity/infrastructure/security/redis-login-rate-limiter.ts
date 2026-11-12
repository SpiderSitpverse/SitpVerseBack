import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { TooManyRequestsError } from '../../../../shared/domain/errors';
import { REDIS_PUBLISHER_CLIENT } from '../../../../shared/infrastructure/redis.provider';
import { logEvent } from '../../../../shared/infrastructure/structured-log';
import { LoginRateLimiterPort } from '../../domain/ports/login-rate-limiter.port';

/**
 * Si Redis no contesta en este tiempo, el límite se omite (el login sigue). Sin esto, con Redis caído cada
 * login esperaría ~30 s a que el cliente agote sus reintentos: la caída del límite no debe frenar a todos.
 */
const REDIS_TIMEOUT_MS = 750;
const WINDOW_MS = 60_000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Redis no respondió en ${REDIS_TIMEOUT_MS} ms`)), REDIS_TIMEOUT_MS),
    ),
  ]);
}

/** Suma 1 y, solo la primera vez, fija el plazo (la ventana empieza ahí). Devuelve [contador, ms que faltan]. */
const HIT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('PTTL', KEYS[1])}`;

/**
 * Límite por IP sobre Redis: `LOGIN_RATE_PER_MINUTE` peticiones por minuto (10 por defecto). Los contadores se
 * comparten entre TODAS las instancias. Cuenta cada petición, buena o mala: el costo de verificar un token es de
 * quien lo pide. Si Redis falla se deja pasar (y se registra), porque el límite es una defensa adicional.
 */
@Injectable()
export class RedisLoginRateLimiter implements LoginRateLimiterPort {
  private readonly max: number;

  constructor(
    @Inject(REDIS_PUBLISHER_CLIENT) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.max = Number(config.get('LOGIN_RATE_PER_MINUTE', 10));
  }

  async assertAllowed(ip: string): Promise<void> {
    let count: number;
    let ttlMs: number;
    try {
      [count, ttlMs] = (await withTimeout(this.redis.eval(HIT, 1, `login:rate:${ip}`, WINDOW_MS))) as [number, number];
    } catch (error) {
      logEvent('error', 'login.limiter_unavailable', { severity: 'ERROR', error: String(error) });
      return;
    }
    if (count > this.max) {
      const seconds = Math.max(1, Math.ceil((ttlMs > 0 ? ttlMs : WINDOW_MS) / 1000));
      logEvent('warn', 'login.rate_limited', { severity: 'WARN', ip, retry_after_s: seconds });
      throw new TooManyRequestsError(`Demasiados intentos. Vuelve a intentarlo en ${seconds} segundo(s)`, seconds);
    }
  }
}
