import { Module } from '@nestjs/common';
import { ClusterMetricsService } from './cluster-metrics.service';
import { HealthController, MetricsController } from './health.controller';

/**
 * Salud (`GET /health`, `/health/live`, `/health/ready`) y métricas (`GET /metrics`) para el despliegue y el monitoreo.
 * Usa Prisma y Redis del SharedModule (global).
 */
@Module({ controllers: [HealthController, MetricsController], providers: [ClusterMetricsService] })
export class HealthModule {}
