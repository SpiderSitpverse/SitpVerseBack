import { Controller, Get, HttpStatus, Res, SetMetadata } from '@nestjs/common';
import { Response } from 'express';
import { REDIS_PUBLISHER_CLIENT } from './redis.provider';
import Redis from 'ioredis';
import { Inject } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { MetricsService } from './metrics.service';

const Public = () => SetMetadata('auth:public', true);
const DEPENDENCY_TIMEOUT_MS = 1000;

function withTimeout<T>(operation: Promise<T>): Promise<T> {
  return Promise.race([
    operation,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`health check timeout after ${DEPENDENCY_TIMEOUT_MS}ms`)),
        DEPENDENCY_TIMEOUT_MS,
      ),
    ),
  ]);
}

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    @Inject(REDIS_PUBLISHER_CLIENT) private readonly redis: Redis,
  ) {}

  @Get('health/live')
  @Public()
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  @Public()
  async ready(@Res({ passthrough: true }) response: Response) {
    const checks = await Promise.all([
      this.check('postgres', () => this.prisma.$queryRaw`SELECT 1`),
      this.check('redis', () => this.redis.ping()),
    ]);
    const ready = checks.every((check) => check.status === 'up');
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? 'ok' : 'failed', checks };
  }

  @Get('metrics')
  @Public()
  metricsEndpoint(@Res({ passthrough: true }) response: Response) {
    response.type('text/plain; version=0.0.4');
    return this.metrics.renderPrometheus();
  }

  private async check(name: string, operation: () => Promise<unknown>) {
    const startedAt = Date.now();
    try {
      await withTimeout(operation());
      const durationMs = Date.now() - startedAt;
      this.metrics.observe('sitpverse_health_check_duration_ms', durationMs, { dependency: name });
      return { name, status: 'up', durationMs };
    } catch (error) {
      this.metrics.increment('sitpverse_health_check_failures_total', { dependency: name });
      return { name, status: 'down', durationMs: Date.now() - startedAt, error: String(error) };
    }
  }
}
