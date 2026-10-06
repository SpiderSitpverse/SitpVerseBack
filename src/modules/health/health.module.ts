import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/** Ruta de salud (`GET /health`) para el despliegue. Usa Prisma y Redis del SharedModule (global). */
@Module({ controllers: [HealthController] })
export class HealthModule {}
