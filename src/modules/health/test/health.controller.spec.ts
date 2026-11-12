import { ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { MetricsService } from '../../../shared/infrastructure/metrics.service';
import { HealthController, MetricsController } from '../health.controller';

let lastMetrics: MetricsService;

const build = (opts: { db?: 'ok' | 'fail' | 'hang'; redis?: 'ok' | 'fail' }) => {
  const prisma = {
    $queryRaw: () =>
      opts.db === 'fail' ? Promise.reject(new Error('db caída')) : opts.db === 'hang' ? new Promise(() => undefined) : Promise.resolve([1]),
  } as unknown as PrismaService;
  const redis = { ping: () => (opts.redis === 'fail' ? Promise.reject(new Error('redis caído')) : Promise.resolve('PONG')) } as unknown as Redis;
  lastMetrics = new MetricsService();
  return new HealthController(prisma, redis, lastMetrics);
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

describe('GET /health/live y /health/ready', () => {
  it('live responde ok sin tocar ninguna dependencia (aunque todo esté caído)', () => {
    expect(build({ db: 'fail', redis: 'fail' }).live()).toMatchObject({ status: 'ok' });
  });

  it('ready con PostgreSQL y Redis arriba: ok y la duración de cada comprobación', async () => {
    const body = await build({}).ready();
    expect(body.status).toBe('ok');
    expect(body.checks.map((c) => [c.name, c.status])).toEqual([['postgres', 'up'], ['redis', 'up']]);
    expect(body.checks.every((c) => Number.isInteger(c.durationMs))).toBe(true);
  });

  it('ready con Redis caído: 503 y dice cuál; y lo cuenta en las métricas', async () => {
    const controller = build({ redis: 'fail' });
    const error = await controller.ready().catch((e) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.getResponse()).toMatchObject({ status: 'failed', checks: [{ name: 'postgres', status: 'up' }, { name: 'redis', status: 'down' }] });
    expect(lastMetrics.renderPrometheus()).toContain('sitpverse_health_check_failures_total{dependency="redis"} 1');
  });

  it('ready no revela errores internos', async () => {
    const error = await build({ db: 'fail', redis: 'fail' }).ready().catch((e) => e);
    expect(JSON.stringify(error.getResponse())).not.toMatch(/caída|password|secret|Error/i);
  });
});

describe('GET /metrics', () => {
  it('devuelve las métricas en formato Prometheus', () => {
    const metrics = new MetricsService();
    metrics.increment('sitpverse_http_requests_total', { method: 'GET', route: '/x', status: '200' });
    metrics.observe('sitpverse_http_request_duration_ms', 42, { method: 'GET', route: '/x' });
    const text = new MetricsController(metrics).render();
    expect(text).toContain('sitpverse_http_requests_total{method="GET",route="/x",status="200"} 1');
    expect(text).toContain('sitpverse_http_request_duration_ms_bucket{le="50",method="GET",route="/x"} 1');
    expect(text).toContain('sitpverse_http_request_duration_ms_count{method="GET",route="/x"} 1');
  });
});
