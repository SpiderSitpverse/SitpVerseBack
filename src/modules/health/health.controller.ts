import { timingSafeEqual } from 'crypto';
import {
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { MetricsService } from '../../shared/infrastructure/metrics.service';
import { PrismaService } from '../../shared/infrastructure/prisma.service';
import { REDIS_PUBLISHER_CLIENT } from '../../shared/infrastructure/redis.provider';
import { Public } from '../identity/public';
import { ClusterMetricsService } from './cluster-metrics.service';

const CHECK_TIMEOUT_MS = 2_000;

type Status = 'up' | 'down';

/** Ejecuta una comprobación con tiempo límite: una dependencia colgada no debe colgar la ruta de salud. */
async function check(probe: () => Promise<unknown>): Promise<Status> {
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS)),
    ]);
    return 'up';
  } catch {
    return 'down';
  }
}

/**
 * Comprobación de salud para el despliegue (Azure "Health check", balanceadores, monitoreo).
 * Pública a propósito y sin datos sensibles: solo dice si la app y sus dependencias responden.
 *
 *   GET /health → 200 { status: "ok",       checks: { database: "up",   redis: "up"   } }
 *               → 503 { status: "degraded", checks: { database: "down", redis: "up"   } }
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_PUBLISHER_CLIENT) private readonly redis: Redis,
    private readonly metrics: MetricsService,
  ) {}

  /** Liveness: el proceso responde. No toca ninguna dependencia (si falla, hay que reiniciar la instancia). */
  @Get('live')
  @Public()
  live() {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  /**
   * Readiness: la instancia puede recibir tráfico (PostgreSQL y Redis responden). 503 si alguna dependencia falla:
   * el balanceador deja de enviarle peticiones. Cada comprobación trae su duración.
   *
   *   GET /health/ready → 200 { status: "ok",     checks: [{ name: "postgres", status: "up", durationMs: 4 }, ...] }
   *                     → 503 { status: "failed", checks: [... { name: "redis", status: "down" }] }
   */
  @Get('ready')
  @Public()
  async ready() {
    const checks = await Promise.all([
      this.timed('postgres', () => this.prisma.$queryRaw`SELECT 1`),
      this.timed('redis', () => this.redis.ping()),
    ]);
    const body = { status: checks.every((c) => c.status === 'up') ? 'ok' : 'failed', checks };
    if (body.status !== 'ok') throw new ServiceUnavailableException(body);
    return body;
  }

  private async timed(name: string, probe: () => Promise<unknown>) {
    const startedAt = Date.now();
    const status = await check(probe);
    const durationMs = Date.now() - startedAt;
    this.metrics.observe('sitpverse_health_check_duration_ms', durationMs, { dependency: name });
    if (status === 'down') this.metrics.increment('sitpverse_health_check_failures_total', { dependency: name });
    return { name, status, durationMs };
  }

  @Get()
  @Public()
  async health() {
    const [database, redis] = await Promise.all([
      check(() => this.prisma.$queryRaw`SELECT 1`),
      check(() => this.redis.ping()),
    ]);
    const body = {
      status: database === 'up' && redis === 'up' ? 'ok' : 'degraded',
      checks: { database, redis },
      uptimeSeconds: Math.round(process.uptime()),
    };
    if (body.status !== 'ok') throw new ServiceUnavailableException(body);
    return body;
  }
}

/**
 * Métricas en formato Prometheus (ESC-OBS-01): las de TODAS las instancias vivas (cada serie con su etiqueta `instance`)
 * más las del sistema (KPIs de negocio, outbox pendiente, buses sin señal, estado de PostgreSQL y Redis). Prometheus las
 * recoge cada 10 s. Ver `ClusterMetricsService`.
 *
 * No pasa por el guard de sesión (Prometheus no es un usuario), pero si `METRICS_TOKEN` está definido exige
 * `Authorization: Bearer <METRICS_TOKEN>`: así las métricas de producción solo las lee el Prometheus autorizado.
 */
@Controller('metrics')
export class MetricsController {
  private readonly token?: string;

  constructor(
    private readonly cluster: ClusterMetricsService,
    config: ConfigService,
  ) {
    this.token = config.get<string>('METRICS_TOKEN') || undefined;
  }

  @Get()
  @Public()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  render(@Headers('authorization') authorization?: string) {
    if (this.token && !sameSecret(authorization ?? '', `Bearer ${this.token}`)) {
      throw new UnauthorizedException('Métricas protegidas: falta el token');
    }
    return this.cluster.render();
  }
}

/** Comparación en tiempo constante (no revela por el tiempo de respuesta cuántos caracteres coinciden). */
function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
