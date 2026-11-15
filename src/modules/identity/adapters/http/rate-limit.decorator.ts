import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'rate:limit';

export interface RateLimitSpec {
  perMinute: number;
  bucket: string;
}

/** Límite MÁS ESTRICTO que el general para una ruta cara (p. ej. subir fotos): `n` peticiones por minuto y usuario. */
export const RateLimit = (perMinute: number, bucket: string) =>
  SetMetadata(RATE_LIMIT_KEY, { perMinute, bucket } satisfies RateLimitSpec);
