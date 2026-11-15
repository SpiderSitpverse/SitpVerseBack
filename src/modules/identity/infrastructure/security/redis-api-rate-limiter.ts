import { Inject, Injectable, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { TooManyRequestsError } from '../../../../shared/domain/errors';
import { MetricsService } from '../../../../shared/infrastructure/metrics.service';
import { REDIS_PUBLISHER_CLIENT } from '../../../../shared/infrastructure/redis.provider';
import { logEvent } from '../../../../shared/infrastructure/structured-log';
import { ApiRateLimiterPort } from '../../domain/ports/api-rate-limiter.port';

const REDIS_TIMEOUT_MS = 500;
const WINDOW_MS = 60_000;

const HIT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('PTTL', KEYS[1])}`;

/**
 * Límite por usuario sobre Redis: los contadores se comparten entre TODAS las instancias del backend. Si Redis no
 * contesta a tiempo el límite se omite (y se registra): es una defensa adicional y su caída no debe tumbar la API.
 */
@Injectable()
export class RedisApiRateLimiter implements ApiRateLimiterPort {
  constructor(
    @Inject(REDIS_PUBLISHER_CLIENT) private readonly redis: Redis,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async assertAllowed(key: string, bucket: string, max: number): Promise<void> {
    let count: number;
    let ttlMs: number;
    try {
      const result = Promise.race([
        this.redis.eval(HIT, 1, `rate:${bucket}:${key}`, WINDOW_MS),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), REDIS_TIMEOUT_MS).unref()),
      ]);
      [count, ttlMs] = (await result) as [number, number];
    } catch (error) {
      logEvent('error', 'api.limiter_unavailable', { severity: 'ERROR', error: String(error) });
      return;
    }
    if (count > max) {
      const seconds = Math.max(1, Math.ceil((ttlMs > 0 ? ttlMs : WINDOW_MS) / 1000));
      this.metrics?.increment('sitpverse_rate_limited_total', { bucket });
      if (count === max + 1) logEvent('warn', 'api.rate_limited', { severity: 'WARN', key, bucket, retry_after_s: seconds });
      throw new TooManyRequestsError(`Demasiadas peticiones. Vuelve a intentarlo en ${seconds} segundo(s)`, seconds);
    }
  }
}
