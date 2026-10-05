import { BusyError } from './errors';

export const DISTRIBUTED_LOCK = Symbol('DISTRIBUTED_LOCK');

export interface LockOptions {
  /** Tiempo de vida del lock: si el proceso muere, Redis lo libera solo. Default 5000. */
  ttlMs?: number;
  /** Cuánto esperar por el lock antes de rendirse. Default 5000. */
  waitMs?: number;
  /** Identificador de seguimiento que se escribe en el log estructurado. */
  traceId?: string;
}

export interface LockResult<T> {
  value: T;
  /** Cuánto esperó para obtener el lock (señal de contención). */
  waitedMs: number;
  /** Cuánto tiempo se mantuvo el lock. */
  heldMs: number;
}

/** No se obtuvo el lock a tiempo: el sistema está saturado, conviene reintentar. → 503 */
export class LockTimeoutError extends BusyError {
  constructor(key: string, waitMs: number) {
    super(`No se pudo obtener el lock "${key}" en ${waitMs}ms`, { lock: key });
  }
}

/**
 * Puerto: exclusión mutua entre TODAS las instancias del backend.
 * Producción: Redis (`RedisDistributedLock`). Tests: mutex en memoria.
 */
export interface DistributedLockPort {
  withLock<T>(
    key: string,
    fn: () => Promise<T>,
    options?: LockOptions,
  ): Promise<LockResult<T>>;
}
