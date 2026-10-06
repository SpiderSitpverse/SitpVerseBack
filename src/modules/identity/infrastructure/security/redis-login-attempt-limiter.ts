import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { TooManyRequestsError } from '../../../../shared/domain/errors';
import { REDIS_PUBLISHER_CLIENT } from '../../../../shared/infrastructure/redis.provider';
import { logEvent } from '../../../../shared/infrastructure/structured-log';
import {
  LoginAttempt,
  LoginAttemptLimiterPort,
} from '../../domain/ports/login-attempt-limiter.port';

/**
 * Si Redis no contesta en este tiempo, el límite se omite (el login sigue). Sin esto, con Redis caído cada
 * login esperaría ~30 s a que el cliente agote sus reintentos: la caída del límite no debe frenar a todos.
 */
const REDIS_TIMEOUT_MS = 750;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Redis no respondió en ${REDIS_TIMEOUT_MS} ms`)), REDIS_TIMEOUT_MS),
    ),
  ]);
}

/** Suma 1 al contador y, solo la primera vez, le pone su plazo de vida (la ventana empieza ahí). */
const INCREMENT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count`;

interface Scope {
  key: string;
  max: number;
}

/**
 * Límite de intentos de login sobre Redis: los contadores se comparten entre TODAS las instancias
 * del backend y caducan solos (no hay nada que limpiar).
 *
 * Si Redis no responde (o tarda más de 750 ms) NO se bloquea el login (se registra el error): el límite es una
 * defensa adicional, y dejar a todos los empleados fuera, o colgados, por una caída sería peor.
 */
@Injectable()
export class RedisLoginAttemptLimiter implements LoginAttemptLimiterPort {
  private readonly maxPerAccountAndIp: number;
  private readonly maxPerIp: number;
  private readonly maxPerAccount: number;
  private readonly lockMs: number;

  constructor(
    @Inject(REDIS_PUBLISHER_CLIENT) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.maxPerAccountAndIp = Number(config.get('LOGIN_MAX_FAILURES', 5));
    this.maxPerIp = Number(config.get('LOGIN_IP_MAX_FAILURES', 100));
    this.maxPerAccount = Number(config.get('LOGIN_ACCOUNT_MAX_FAILURES', 20));
    this.lockMs = Number(config.get('LOGIN_LOCK_MINUTES', 15)) * 60_000;
  }

  private scopes({ employeeId, ip }: LoginAttempt): Scope[] {
    return [
      { key: `login:fail:pair:{${employeeId}}:${ip}`, max: this.maxPerAccountAndIp },
      { key: `login:fail:ip:${ip}`, max: this.maxPerIp },
      { key: `login:fail:acct:${employeeId}`, max: this.maxPerAccount },
    ];
  }

  async assertNotBlocked(attempt: LoginAttempt): Promise<void> {
    try {
      for (const { key, max } of this.scopes(attempt)) {
        const count = Number((await withTimeout(this.redis.get(key))) ?? 0);
        if (count >= max) {
          const ttlMs = await withTimeout(this.redis.pttl(key));
          const seconds = Math.max(1, Math.ceil((ttlMs > 0 ? ttlMs : this.lockMs) / 1000));
          logEvent('warn', 'login.blocked', { severity: 'WARN', employee: attempt.employeeId, ip: attempt.ip, retry_after_s: seconds });
          throw new TooManyRequestsError(
            `Demasiados intentos fallidos. Vuelve a intentarlo en ${Math.ceil(seconds / 60)} minuto(s)`,
            seconds,
          );
        }
      }
    } catch (error) {
      if (error instanceof TooManyRequestsError) throw error;
      logEvent('error', 'login.limiter_unavailable', { severity: 'ERROR', error: String(error) });
    }
  }

  async recordFailure(attempt: LoginAttempt): Promise<void> {
    try {
      await Promise.all(
        this.scopes(attempt).map(({ key }) => withTimeout(this.redis.eval(INCREMENT, 1, key, this.lockMs))),
      );
    } catch (error) {
      logEvent('error', 'login.limiter_unavailable', { severity: 'ERROR', error: String(error) });
    }
  }

  async recordSuccess(attempt: LoginAttempt): Promise<void> {
    try {
      await withTimeout(this.redis.del(this.scopes(attempt)[0].key));
    } catch (error) {
      logEvent('error', 'login.limiter_unavailable', { severity: 'ERROR', error: String(error) });
    }
  }
}
