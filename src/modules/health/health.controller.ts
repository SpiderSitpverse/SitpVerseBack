import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
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
  ) {}

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
