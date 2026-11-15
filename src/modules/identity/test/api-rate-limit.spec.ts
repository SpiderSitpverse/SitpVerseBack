import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import Redis from 'ioredis';
import { TooManyRequestsError } from '../../../shared/domain/errors';
import { ApiRateLimitGuard } from '../adapters/http/api-rate-limit.guard';
import { Public } from '../adapters/http/auth.decorators';
import { RateLimit } from '../adapters/http/rate-limit.decorator';
import { ApiRateLimiterPort } from '../domain/ports/api-rate-limiter.port';
import { RedisApiRateLimiter } from '../infrastructure/security/redis-api-rate-limiter';

/** Redis en memoria con el mismo contrato que usa el limitador (INCR con ventana). */
function fakeRedis(opts: { down?: boolean } = {}) {
  const counters = new Map<string, number>();
  return {
    counters,
    eval: async (_script: string, _n: number, key: string) => {
      if (opts.down) throw new Error('redis caído');
      const count = (counters.get(key) ?? 0) + 1;
      counters.set(key, count);
      return [count, 42_000];
    },
  } as unknown as Redis & { counters: Map<string, number> };
}

describe('RedisApiRateLimiter', () => {
  it('deja pasar hasta el máximo y luego responde 429 con el tiempo de espera', async () => {
    const limiter = new RedisApiRateLimiter(fakeRedis());
    for (let i = 0; i < 3; i++) await limiter.assertAllowed('user:1', 'api', 3);
    const error = await limiter.assertAllowed('user:1', 'api', 3).catch((e) => e);
    expect(error).toBeInstanceOf(TooManyRequestsError);
    expect(error.retryAfterSeconds).toBe(42);
  });

  it('cada usuario y cada grupo llevan su propia cuenta', async () => {
    const limiter = new RedisApiRateLimiter(fakeRedis());
    await limiter.assertAllowed('user:1', 'api', 1);
    await expect(limiter.assertAllowed('user:2', 'api', 1)).resolves.toBeUndefined();
    await expect(limiter.assertAllowed('user:1', 'upload', 1)).resolves.toBeUndefined();
    await expect(limiter.assertAllowed('user:1', 'api', 1)).rejects.toBeInstanceOf(TooManyRequestsError);
  });

  it('si Redis cae el límite se omite: la API sigue funcionando', async () => {
    const limiter = new RedisApiRateLimiter(fakeRedis({ down: true }));
    await expect(limiter.assertAllowed('user:1', 'api', 1)).resolves.toBeUndefined();
  });

  it('cuenta lo limitado en las métricas', async () => {
    const increments: string[] = [];
    const limiter = new RedisApiRateLimiter(fakeRedis(), { increment: (name: string) => void increments.push(name) } as never);
    await limiter.assertAllowed('user:1', 'api', 0).catch(() => undefined);
    expect(increments).toEqual(['sitpverse_rate_limited_total']);
  });
});

class FakeController {
  plain() {}
  @RateLimit(2, 'upload') upload() {}
  @Public() open() {}
}

describe('ApiRateLimitGuard', () => {
  const calls: [string, string, number][] = [];
  const limiter: ApiRateLimiterPort = { assertAllowed: async (key, bucket, max) => void calls.push([key, bucket, max]) };
  const guard = new ApiRateLimitGuard(new Reflector(), limiter, { get: (_k: string, d: number) => d } as unknown as ConfigService);
  const controller = new FakeController();
  const context = (handler: () => void, user?: { id: string }, type = 'http') =>
    ({
      getType: () => type,
      getHandler: () => handler,
      getClass: () => FakeController,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  beforeEach(() => (calls.length = 0));

  it('limita por usuario con el máximo general (600 por minuto)', async () => {
    await guard.canActivate(context(controller.plain, { id: 'u1' }));
    expect(calls).toEqual([['user:u1', 'api', 600]]);
  });

  it('una ruta con @RateLimit suma su límite más estricto', async () => {
    await guard.canActivate(context(controller.upload, { id: 'u1' }));
    expect(calls).toEqual([['user:u1', 'api', 600], ['user:u1', 'upload', 2]]);
  });

  it('las rutas públicas, las peticiones sin usuario y los sockets no se limitan aquí', async () => {
    await guard.canActivate(context(controller.open, { id: 'u1' }));
    await guard.canActivate(context(controller.plain, undefined));
    await guard.canActivate(context(controller.plain, { id: 'u1' }, 'ws'));
    expect(calls).toEqual([]);
  });
});
