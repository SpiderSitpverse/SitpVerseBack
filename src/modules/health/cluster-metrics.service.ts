import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { MetricsService } from '../../shared/infrastructure/metrics.service';
import { PrismaService } from '../../shared/infrastructure/prisma.service';
import { REDIS_PUBLISHER_CLIENT } from '../../shared/infrastructure/redis.provider';

/** Hash de Redis: campo = instancia, valor = { at, text } con sus métricas. */
const SNAPSHOTS_KEY = 'sitpverse:metrics:instances';
/** Cada cuánto publica cada instancia sus métricas. */
const PUBLISH_EVERY_MS = 4_000;
/** Una instancia que no publica en este tiempo se da por caída y sale del resultado. */
const STALE_AFTER_MS = 12_000;
/** Las métricas de negocio se consultan a la base como mucho cada 5 s, se pidan las veces que se pidan. */
const CLUSTER_CACHE_MS = 5_000;
const QUERY_TIMEOUT_MS = 3_000;

interface ClusterRow {
  outbox_pending: bigint;
  buses_total: bigint;
  buses_in_service: bigint;
  buses_no_signal: bigint;
  buses_in_repair: bigint;
  mttr_seconds: number | null;
  routes_accepted: bigint;
  routes_assigned: bigint;
  calls_total: bigint;
  calls_overassigned: bigint;
  claims_total: bigint;
  accept_seconds: number | null;
  incidents_total: bigint;
  incidents_open: bigint;
  tows_total: bigint;
  inspections_total: bigint;
  active_users: bigint;
  logins_ok: bigint;
  logins_rejected: bigint;
  trips_started: bigint;
  trips_finished: bigint;
}

const withTimeout = <T>(work: Promise<T>): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), QUERY_TIMEOUT_MS).unref()),
  ]);

/**
 * Métricas del CLÚSTER completo (ESC-OBS-01).
 *
 * Detrás del balanceador de App Service, Prometheus no puede elegir a qué instancia le pregunta: cada consulta cae en
 * una cualquiera. Por eso cada instancia publica sus métricas en Redis cada 4 s y `GET /metrics`, lo atienda quien lo
 * atienda, responde las de TODAS las instancias vivas (cada serie con su etiqueta `instance`). Una instancia que deja
 * de publicar (se cayó) desaparece del resultado en 12 s: el tablero la ve caer sin esperar a Azure.
 *
 * Además añade, una sola vez, las métricas que son del sistema y no de una instancia: los KPIs de negocio, el outbox
 * pendiente, los buses sin señal y el estado de PostgreSQL y Redis.
 */
@Injectable()
export class ClusterMetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClusterMetricsService.name);
  private timer?: NodeJS.Timeout;
  private cached?: { at: number; text: string };

  constructor(
    private readonly metrics: MetricsService,
    private readonly prisma: PrismaService,
    @Inject(REDIS_PUBLISHER_CLIENT) private readonly redis: Redis,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.publish(), PUBLISH_EVERY_MS);
    this.timer.unref();
    void this.publish();
  }

  /** Apagado limpio: la instancia sale de las métricas de inmediato (si muere de golpe, sale al vencer su publicación). */
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.redis.hdel(SNAPSHOTS_KEY, this.metrics.instanceId).catch(() => undefined);
  }

  /** Publica en Redis las métricas de esta instancia. */
  async publish(now = Date.now()): Promise<void> {
    try {
      const snapshot = JSON.stringify({ at: now, text: this.metrics.renderInstance() });
      await this.redis.hset(SNAPSHOTS_KEY, this.metrics.instanceId, snapshot);
    } catch (error) {
      this.logger.warn(JSON.stringify({ event: 'metrics.publish_failed', severity: 'WARN', error: String(error) }));
    }
  }

  /** Las métricas de todas las instancias vivas + las del sistema. Nunca falla: si Redis o la base caen, lo dice. */
  async render(now = Date.now()): Promise<string> {
    const parts = [this.metrics.renderInstance()];
    let instances = 1;
    let redisUp = 1;
    try {
      const snapshots = await withTimeout(this.redis.hgetall(SNAPSHOTS_KEY));
      for (const [instance, raw] of Object.entries(snapshots)) {
        if (instance === this.metrics.instanceId) continue;
        const snapshot = JSON.parse(raw) as { at: number; text: string };
        if (now - snapshot.at > STALE_AFTER_MS) {
          void this.redis.hdel(SNAPSHOTS_KEY, instance).catch(() => undefined);
          continue;
        }
        parts.push(snapshot.text);
        instances += 1;
      }
    } catch {
      redisUp = 0;
    }
    const system = await this.systemMetrics(now);
    return [
      ...parts,
      `sitpverse_instances ${instances}`,
      `sitpverse_dependency_up{dependency="redis"} ${redisUp}`,
      system,
    ].join('\n').replace(/\n{2,}/g, '\n') + '\n';
  }

  private async systemMetrics(now: number): Promise<string> {
    if (this.cached && now - this.cached.at < CLUSTER_CACHE_MS) return this.cached.text;
    let text: string;
    try {
      text = ['sitpverse_dependency_up{dependency="postgres"} 1', ...this.format(await withTimeout(this.query()))].join('\n');
    } catch (error) {
      this.logger.warn(JSON.stringify({ event: 'metrics.system_query_failed', severity: 'WARN', error: String(error) }));
      text = 'sitpverse_dependency_up{dependency="postgres"} 0';
    }
    this.cached = { at: now, text };
    return text;
  }

  /** UNA sola consulta (una ida a la base) con todos los números de negocio y de estado. */
  private async query(): Promise<ClusterRow> {
    const rows = await this.prisma.$queryRaw<ClusterRow[]>`
      SELECT
        (SELECT count(*) FROM "outbox_events" WHERE "publishedAt" IS NULL) AS outbox_pending,
        (SELECT count(*) FROM "buses") AS buses_total,
        (SELECT count(*) FROM "buses" WHERE "status" = 'IN_SERVICE') AS buses_in_service,
        (SELECT count(*) FROM "buses"
          WHERE "status" = 'IN_SERVICE' AND "updatedAt" < (now() AT TIME ZONE 'utc') - interval '15 seconds') AS buses_no_signal,
        (SELECT count(DISTINCT "busId") FROM "assistance_calls" WHERE "kind" = 'REPAIR' AND "status" <> 'COMPLETED') AS buses_in_repair,
        (SELECT avg(extract(epoch FROM "completedAt" - "createdAt"))::float8 FROM "assistance_calls" WHERE "completedAt" IS NOT NULL) AS mttr_seconds,
        (SELECT count(*) FROM "alternative_routes" WHERE "status" = 'ACCEPTED') AS routes_accepted,
        (SELECT count(*) FROM "alternative_routes" WHERE "status" IN ('ASSIGNED', 'ACCEPTED')) AS routes_assigned,
        (SELECT count(*) FROM "assistance_calls") AS calls_total,
        (SELECT count(*) FROM "assistance_calls" c
          WHERE (SELECT count(*) FROM "assistance_claims" k WHERE k."callId" = c."id" AND k."status" = 'ACTIVE') > c."slots") AS calls_overassigned,
        (SELECT count(*) FROM "assistance_claims") AS claims_total,
        (SELECT avg(extract(epoch FROM k."createdAt" - c."createdAt"))::float8
           FROM "assistance_claims" k JOIN "assistance_calls" c ON c."id" = k."callId") AS accept_seconds,
        (SELECT count(*) FROM "driver_incidents") AS incidents_total,
        (SELECT count(*) FROM "driver_incidents" WHERE "status" <> 'RESOLVED') AS incidents_open,
        (SELECT count(*) FROM "tow_assignments") AS tows_total,
        (SELECT count(*) FROM "bus_inspections") AS inspections_total,
        (SELECT count(DISTINCT "userId") FROM "request_log"
          WHERE "at" > (now() AT TIME ZONE 'utc') - interval '5 minutes' AND "userId" IS NOT NULL) AS active_users,
        (SELECT count(*) FROM "audit_log" WHERE "action" = 'auth.login' AND "outcome" = 'SUCCESS') AS logins_ok,
        (SELECT count(*) FROM "audit_log" WHERE "action" = 'auth.login' AND "outcome" <> 'SUCCESS') AS logins_rejected,
        (SELECT count(*) FROM "audit_log" WHERE "action" = 'trip.start' AND "outcome" = 'SUCCESS') AS trips_started,
        (SELECT count(*) FROM "audit_log" WHERE "action" = 'trip.finish' AND "outcome" = 'SUCCESS') AS trips_finished`;
    return rows[0];
  }

  private format(row: ClusterRow): string[] {
    const n = (value: bigint | number) => Number(value);
    const lines = [
      // Técnicas
      `sitpverse_outbox_pending ${n(row.outbox_pending)}`,
      `sitpverse_buses_total ${n(row.buses_total)}`,
      `sitpverse_buses_in_service ${n(row.buses_in_service)}`,
      `sitpverse_buses_without_signal ${n(row.buses_no_signal)}`,
      // Negocio
      `sitpverse_active_users_5m ${n(row.active_users)}`,
      `sitpverse_logins{outcome="success"} ${n(row.logins_ok)}`,
      `sitpverse_logins{outcome="rejected"} ${n(row.logins_rejected)}`,
      `sitpverse_trips{event="started"} ${n(row.trips_started)}`,
      `sitpverse_trips{event="finished"} ${n(row.trips_finished)}`,
      `sitpverse_incidents_reported ${n(row.incidents_total)}`,
      `sitpverse_incidents_open ${n(row.incidents_open)}`,
      `sitpverse_alerts_accepted ${n(row.claims_total)}`,
      `sitpverse_tows_assigned ${n(row.tows_total)}`,
      `sitpverse_inspections_registered ${n(row.inspections_total)}`,
      `sitpverse_alternative_routes{status="assigned"} ${n(row.routes_assigned)}`,
      `sitpverse_alternative_routes{status="accepted"} ${n(row.routes_accepted)}`,
    ];
    // KPIs del Inception (una proporción solo existe si hay con qué calcularla).
    const total = n(row.buses_total);
    if (total > 0) lines.push(`sitpverse_kpi_fleet_availability_ratio ${((total - n(row.buses_in_repair)) / total).toFixed(4)}`);
    const calls = n(row.calls_total);
    lines.push(`sitpverse_kpi_conflict_free_assignments_ratio ${calls > 0 ? ((calls - n(row.calls_overassigned)) / calls).toFixed(4) : 1}`);
    lines.push(`sitpverse_assignments_overassigned ${n(row.calls_overassigned)}`);
    const assigned = n(row.routes_assigned);
    if (assigned > 0) lines.push(`sitpverse_kpi_diversion_effectiveness_ratio ${(n(row.routes_accepted) / assigned).toFixed(4)}`);
    if (row.mttr_seconds !== null) lines.push(`sitpverse_kpi_mttr_seconds ${Number(row.mttr_seconds).toFixed(1)}`);
    if (row.accept_seconds !== null) lines.push(`sitpverse_alert_accept_seconds_avg ${Number(row.accept_seconds).toFixed(1)}`);
    return lines;
  }
}
