import {
  DistributedLockPort,
  LockOptions,
  LockResult,
} from '../domain/distributed-lock.port';

/**
 * Mutex por clave en memoria: mismo contrato que el lock de Redis para tests.
 * `maxConcurrentInside` permite afirmar que NUNCA hubo dos dentro de la misma sección.
 */
export class InMemoryLock implements DistributedLockPort {
  private tails = new Map<string, Promise<unknown>>();
  private inside = new Map<string, number>();
  maxConcurrentInside = 0;

  async withLock<T>(
    key: string,
    fn: () => Promise<T>,
    _options?: LockOptions,
  ): Promise<LockResult<T>> {
    const requestedAt = Date.now();
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.tails.set(key, previous.then(() => gate));
    await previous;

    const acquiredAt = Date.now();
    const now = (this.inside.get(key) ?? 0) + 1;
    this.inside.set(key, now);
    this.maxConcurrentInside = Math.max(this.maxConcurrentInside, now);
    try {
      const value = await fn();
      return { value, waitedMs: acquiredAt - requestedAt, heldMs: Date.now() - acquiredAt };
    } finally {
      this.inside.set(key, now - 1);
      release();
    }
  }
}

/** Sin exclusión mutua: demuestra que la atomicidad de la BD sola ya evita duplicados. */
export class NoopLock implements DistributedLockPort {
  async withLock<T>(_key: string, fn: () => Promise<T>): Promise<LockResult<T>> {
    return { value: await fn(), waitedMs: 0, heldMs: 0 };
  }
}
