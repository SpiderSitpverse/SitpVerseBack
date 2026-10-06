import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import {
  DistributedLockPort,
  LockOptions,
  LockResult,
  LockTimeoutError,
} from '../domain/distributed-lock.port';
import { REDIS_PUBLISHER_CLIENT } from './redis.provider';
import { logEvent } from './structured-log';

/** Contención: esperar más de esto por un lock se registra como WARN. */
const CONTENTION_WARN_MS = 50;
/** Los contadores de una cola se descartan solos tras este tiempo sin uso. */
const KEY_TTL_MS = 10 * 60 * 1000;
const POLL_MS = 8;

/**
 * Cada petición toma un número de turno (INCR, atómico) y deja un "lease" que prueba que
 * sigue viva. El lease nace en el MISMO script que el turno: así nadie puede ver un turno
 * sin lease y confundirlo con uno abandonado.
 *   KEYS[1]=next  KEYS[2]=serving   ARGV[1]=prefijo de lease  ARGV[2]=ttl lease  ARGV[3]=ttl claves
 */
const TAKE_TICKET = `
local ticket = redis.call('INCR', KEYS[1])
redis.call('SET', ARGV[1] .. ticket, '1', 'PX', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return ticket`;

/**
 * ¿Es mi turno? Salta los turnos de procesos que murieron o desistieron (su lease expiró o
 * se borró). Si es mi turno, renueva mi lease con el TTL de la sección crítica.
 *   ARGV[1]=mi turno  ARGV[2]=prefijo de lease  ARGV[3]=ttl claves  ARGV[4]=ttl sección crítica
 */
const IS_MY_TURN = `
local serving = tonumber(redis.call('GET', KEYS[2]) or '0')
local ticket = tonumber(ARGV[1])
if ticket <= serving then serving = ticket - 1 end -- contadores desincronizados (p. ej. Redis reiniciado)
while serving + 1 < ticket do
  if redis.call('EXISTS', ARGV[2] .. (serving + 1)) == 0 then
    serving = serving + 1
  else
    break
  end
end
redis.call('SET', KEYS[2], serving, 'PX', ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
if serving + 1 == ticket then
  redis.call('SET', ARGV[2] .. ticket, '1', 'PX', ARGV[4])
  return 1
end
return 0`;

/** Pasa el turno al siguiente (si el mío estaba en curso) y borra mi lease. */
const RELEASE = `
local serving = tonumber(redis.call('GET', KEYS[2]) or '0')
local ticket = tonumber(ARGV[1])
if serving + 1 == ticket then redis.call('SET', KEYS[2], ticket, 'PX', ARGV[3]) end
redis.call('DEL', ARGV[2] .. ticket)
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lock distribuido FIFO ESTRICTO sobre Redis (ticket lock).
 *
 * El orden lo fija `INCR` (atómico, un único punto de serialización para todas las
 * instancias del backend): quien llegó primero a Redis entra primero. Quien muere o se
 * rinde esperando no bloquea la cola: su lease desaparece y el turno se salta. Si una
 * sección crítica excede `ttlMs`, su lease vence y la cola avanza (igual que el TTL de un
 * lock normal); la decisión real de consistencia sigue siendo el CAS de Postgres.
 *
 * Los scripts arman claves a partir de un prefijo (no solo `KEYS`). Todas comparten un hash tag
 * `{clave}`, así funciona igual en un Redis standalone que en uno en clúster.
 */
@Injectable()
export class RedisDistributedLock implements DistributedLockPort {
  constructor(@Inject(REDIS_PUBLISHER_CLIENT) private readonly redis: Redis) {}

  async withLock<T>(
    key: string,
    fn: () => Promise<T>,
    { ttlMs = 5000, waitMs = 5000, traceId }: LockOptions = {},
  ): Promise<LockResult<T>> {
    // Las llaves entre {} (hash tag) hacen que TODAS las claves de este lock vivan en el mismo slot:
    // sin eso, en un Redis en clúster los scripts Lua que tocan varias claves fallan con CROSSSLOT.
    const tag = `{${key}}`;
    const keys = [`${tag}:next`, `${tag}:serving`];
    const leasePrefix = `${tag}:lease:`;
    const requestedAt = Date.now();

    const ticket = Number(
      await this.redis.eval(
        TAKE_TICKET, 2, ...keys, leasePrefix, waitMs + ttlMs + 1000, KEY_TTL_MS,
      ),
    );

    try {
      while (
        !(await this.redis.eval(
          IS_MY_TURN, 2, ...keys, ticket, leasePrefix, KEY_TTL_MS, ttlMs,
        ))
      ) {
        if (Date.now() - requestedAt >= waitMs) {
          logEvent('error', 'lock.timeout', {
            trace_id: traceId, lock: key, severity: 'ERROR', waited_ms: waitMs,
          });
          throw new LockTimeoutError(key, waitMs);
        }
        await sleep(POLL_MS);
      }

      const acquiredAt = Date.now();
      const value = await fn();
      return this.report(key, traceId, ticket, requestedAt, acquiredAt, value);
    } finally {
      await this.redis.eval(RELEASE, 2, ...keys, ticket, leasePrefix, KEY_TTL_MS);
    }
  }

  private report<T>(
    key: string,
    traceId: string | undefined,
    ticket: number,
    requestedAt: number,
    acquiredAt: number,
    value: T,
  ): LockResult<T> {
    const waitedMs = acquiredAt - requestedAt;
    const heldMs = Date.now() - acquiredAt;
    const contended = waitedMs > CONTENTION_WARN_MS;
    logEvent(contended ? 'warn' : 'log', 'lock.released', {
      trace_id: traceId,
      lock: key,
      ticket,
      severity: contended ? 'WARN' : 'INFO',
      waited_ms: waitedMs,
      held_ms: heldMs,
    });
    return { value, waitedMs, heldMs };
  }
}
