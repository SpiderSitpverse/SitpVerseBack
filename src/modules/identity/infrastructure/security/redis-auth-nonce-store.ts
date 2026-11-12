import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import Redis from 'ioredis';
import { REDIS_PUBLISHER_CLIENT } from '../../../../shared/infrastructure/redis.provider';
import { AuthNonceStorePort } from '../../domain/ports/auth-nonce.port';

const NONCE_TTL_SECONDS = 300;
const KEY = (nonce: string) => `auth:nonce:${nonce}`;

/** Nonces de un solo uso en Redis: compartidos por todas las instancias y con caducidad de 5 minutos. */
@Injectable()
export class RedisAuthNonceStore implements AuthNonceStorePort {
  constructor(@Inject(REDIS_PUBLISHER_CLIENT) private readonly redis: Redis) {}

  async issue(): Promise<string> {
    const nonce = randomBytes(24).toString('base64url');
    await this.redis.set(KEY(nonce), '1', 'EX', NONCE_TTL_SECONDS);
    return nonce;
  }

  /** `DEL` es atómico y dice cuántas claves borró: dos intentos con el mismo nonce, solo uno recibe 1. */
  async consume(nonce: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return false;
    return (await this.redis.del(KEY(nonce))) === 1;
  }
}
