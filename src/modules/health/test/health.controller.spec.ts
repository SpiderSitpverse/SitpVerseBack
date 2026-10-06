import { ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { HealthController } from '../health.controller';

const build = (opts: { db?: 'ok' | 'fail' | 'hang'; redis?: 'ok' | 'fail' }) => {
  const prisma = {
    $queryRaw: () =>
      opts.db === 'fail' ? Promise.reject(new Error('db caída')) : opts.db === 'hang' ? new Promise(() => undefined) : Promise.resolve([1]),
  } as unknown as PrismaService;
  const redis = { ping: () => (opts.redis === 'fail' ? Promise.reject(new Error('redis caído')) : Promise.resolve('PONG')) } as unknown as Redis;
  return new HealthController(prisma, redis);
};

describe('GET /health', () => {
  it('con la base de datos y Redis arriba responde ok', async () => {
    expect(await build({}).health()).toMatchObject({ status: 'ok', checks: { database: 'up', redis: 'up' } });
  });

  it('si Redis cae responde 503 y dice cuál', async () => {
    const error = await build({ redis: 'fail' }).health().catch((e) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.getResponse()).toMatchObject({ status: 'degraded', checks: { database: 'up', redis: 'down' } });
  });

  it('si la base de datos cae responde 503', async () => {
    const error = await build({ db: 'fail' }).health().catch((e) => e);
    expect(error.getResponse()).toMatchObject({ checks: { database: 'down', redis: 'up' } });
  });

  it('una dependencia colgada no cuelga la ruta: tiempo límite de 2 s → 503', async () => {
    const started = Date.now();
    const error = await build({ db: 'hang' }).health().catch((e) => e);
    expect(Date.now() - started).toBeLessThan(3500);
    expect(error.getResponse()).toMatchObject({ checks: { database: 'down' } });
  }, 10_000);

  it('no revela nada sensible (versiones, cadenas de conexión, errores internos)', async () => {
    const error = await build({ db: 'fail', redis: 'fail' }).health().catch((e) => e);
    expect(JSON.stringify(error.getResponse())).not.toMatch(/caída|postgres|password|secret|Error/i);
  });
});
