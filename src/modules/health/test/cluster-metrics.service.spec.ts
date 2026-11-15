import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { MetricsService } from '../../../shared/infrastructure/metrics.service';
import { PrismaService } from '../../../shared/infrastructure/prisma.service';
import { ClusterMetricsService } from '../cluster-metrics.service';
import { MetricsController } from '../health.controller';

const ROW = {
  outbox_pending: 3n,
  buses_total: 60n,
  buses_in_service: 58n,
  buses_no_signal: 2n,
  buses_in_repair: 3n,
  mttr_seconds: 420.5,
  routes_accepted: 9n,
  routes_assigned: 10n,
  calls_total: 20n,
  calls_overassigned: 0n,
  claims_total: 31n,
  accept_seconds: 12.34,
  incidents_total: 14n,
  incidents_open: 2n,
  tows_total: 4n,
  inspections_total: 55n,
  active_users: 17n,
  logins_ok: 200n,
  logins_rejected: 6n,
  trips_started: 120n,
  trips_finished: 118n,
};

function build(opts: { redisDown?: boolean; dbDown?: boolean; row?: Partial<typeof ROW> } = {}) {
  const hash = new Map<string, string>();
  const redis = {
    hset: async (_key: string, field: string, value: string) => {
      if (opts.redisDown) throw new Error('redis caído');
      hash.set(field, value);
    },
    hgetall: async () => {
      if (opts.redisDown) throw new Error('redis caído');
      return Object.fromEntries(hash);
    },
    hdel: async (_key: string, field: string) => void hash.delete(field),
  } as unknown as Redis;
  let queries = 0;
  const prisma = {
    $queryRaw: async () => {
      queries += 1;
      if (opts.dbDown) throw new Error('db caída');
      return [{ ...ROW, ...opts.row }];
    },
  } as unknown as PrismaService;
  const metrics = new MetricsService();
  const service = new ClusterMetricsService(metrics, prisma, redis);
  return { service, metrics, hash, queries: () => queries };
}

const snapshotOf = (instance: string, at: number) =>
  JSON.stringify({ at, text: `sitpverse_instance_up{instance="${instance}"} 1\n` });

describe('ClusterMetricsService (ESC-OBS-01)', () => {
  it('responde las métricas de TODAS las instancias vivas, cada una con su etiqueta instance', async () => {
    const { service, metrics, hash } = build();
    metrics.increment('sitpverse_http_requests_total', { method: 'GET', route: '/x', status: '200' });
    hash.set('otra-1', snapshotOf('otra-1', 1_000_000));
    hash.set('otra-2', snapshotOf('otra-2', 1_000_000));

    const text = await service.render(1_005_000);

    expect(text).toContain(`sitpverse_http_requests_total{instance="${metrics.instanceId}",method="GET",route="/x",status="200"} 1`);
    expect(text).toContain(`sitpverse_instance_up{instance="${metrics.instanceId}"} 1`);
    expect(text).toContain('sitpverse_instance_up{instance="otra-1"} 1');
    expect(text).toContain('sitpverse_instance_up{instance="otra-2"} 1');
    expect(text).toContain('sitpverse_instances 3');
  });

  it('una instancia que dejó de publicar hace más de 12 s (se cayó) desaparece del resultado', async () => {
    const { service, hash } = build();
    hash.set('viva', snapshotOf('viva', 1_000_000));
    hash.set('caida', snapshotOf('caida', 980_000));

    const text = await service.render(1_000_500);

    expect(text).toContain('instance="viva"');
    expect(text).not.toContain('instance="caida"');
    expect(text).toContain('sitpverse_instances 2');
    expect(hash.has('caida')).toBe(false);
  });

  it('publish() guarda las métricas de esta instancia y no se cuenta dos veces a sí misma', async () => {
    const { service, metrics, hash } = build();
    await service.publish(1_000_000);
    expect(hash.has(metrics.instanceId)).toBe(true);
    expect(await service.render(1_001_000)).toContain('sitpverse_instances 1');
  });

  it('al apagarse limpio, la instancia sale de las métricas de inmediato', async () => {
    const { service, metrics, hash } = build();
    await service.publish();
    await service.onModuleDestroy();
    expect(hash.has(metrics.instanceId)).toBe(false);
  });

  it('añade los KPIs de negocio y el estado del sistema, calculados con UNA consulta', async () => {
    const { service, queries } = build();
    const text = await service.render();

    expect(queries()).toBe(1);
    for (const line of [
      'sitpverse_kpi_mttr_seconds 420.5',
      'sitpverse_kpi_diversion_effectiveness_ratio 0.9000',
      'sitpverse_kpi_fleet_availability_ratio 0.9500',
      'sitpverse_kpi_conflict_free_assignments_ratio 1.0000',
      'sitpverse_assignments_overassigned 0',
      'sitpverse_buses_without_signal 2',
      'sitpverse_outbox_pending 3',
      'sitpverse_active_users_5m 17',
      'sitpverse_logins{outcome="success"} 200',
      'sitpverse_logins{outcome="rejected"} 6',
      'sitpverse_trips{event="started"} 120',
      'sitpverse_alerts_accepted 31',
      'sitpverse_alert_accept_seconds_avg 12.3',
      'sitpverse_tows_assigned 4',
      'sitpverse_dependency_up{dependency="postgres"} 1',
      'sitpverse_dependency_up{dependency="redis"} 1',
    ]) {
      expect(text).toContain(line);
    }
  });

  it('una proporción sin datos no se inventa: sin rutas asignadas ni alertas cerradas, esos KPIs no salen', async () => {
    const { service } = build({ row: { routes_assigned: 0n, routes_accepted: 0n, mttr_seconds: null as never, calls_total: 0n } });
    const text = await service.render();
    expect(text).not.toContain('sitpverse_kpi_diversion_effectiveness_ratio');
    expect(text).not.toContain('sitpverse_kpi_mttr_seconds');
    expect(text).toContain('sitpverse_kpi_conflict_free_assignments_ratio 1');
  });

  it('las métricas del sistema se consultan a la base como mucho cada 5 s', async () => {
    const { service, queries } = build();
    await service.render(1_000_000);
    await service.render(1_002_000);
    expect(queries()).toBe(1);
    await service.render(1_006_000);
    expect(queries()).toBe(2);
  });

  it('si PostgreSQL o Redis caen, /metrics sigue respondiendo y lo dice', async () => {
    const db = await build({ dbDown: true }).service.render();
    expect(db).toContain('sitpverse_dependency_up{dependency="postgres"} 0');
    const redis = await build({ redisDown: true }).service.render();
    expect(redis).toContain('sitpverse_dependency_up{dependency="redis"} 0');
    expect(redis).toContain('sitpverse_instances 1');
  });
});

describe('GET /metrics', () => {
  const controller = (token?: string) => {
    const { service } = build();
    return new MetricsController(service, { get: () => token } as unknown as ConfigService);
  };

  it('sin METRICS_TOKEN es público (como /health) y devuelve formato Prometheus', async () => {
    expect(await controller().render()).toContain('sitpverse_instances 1');
  });

  it('con METRICS_TOKEN exige Authorization: Bearer <token>', async () => {
    const protectedController = controller('secreto-de-prometheus');
    expect(() => protectedController.render()).toThrow(UnauthorizedException);
    expect(() => protectedController.render('Bearer otro')).toThrow(UnauthorizedException);
    expect(await protectedController.render('Bearer secreto-de-prometheus')).toContain('sitpverse_instances 1');
  });
});
