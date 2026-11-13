import { Controller, Get, Header, Inject, ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
import { MetricsService } from '../../shared/infrastructure/metrics.service';
import { PrismaService } from '../../shared/infrastructure/prisma.service';
import { REDIS_PUBLISHER_CLIENT } from '../../shared/infrastructure/redis.provider';
import { Public } from '../identity/public';

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
 * Métricas en formato Prometheus de ESTA instancia (latencia y total de peticiones por ruta, conexiones y eventos
 * WebSocket, latencia de entrega de eventos, comprobaciones de salud). Prometheus las recoge cada 15 s.
 * Pública a propósito, como `/health`: solo trae contadores, sin datos de personas.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Public()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  render() {
    return this.metrics.renderPrometheus();
  }
}
