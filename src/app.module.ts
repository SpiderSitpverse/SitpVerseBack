import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AssistanceModule } from './modules/assistance/public';
import { FleetModule } from './modules/fleet/public';
import { HealthModule } from './modules/health/public';
import { IdentityModule } from './modules/identity/public';
import { InspectionsModule } from './modules/inspections/public';
import { UploadsModule } from './modules/uploads/public';
import { RealtimeModule } from './realtime/realtime.module';
import { SharedModule } from './shared/shared.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SharedModule, // Prisma + Redis + lock FIFO + outbox (global)

    // Módulos de negocio (cada uno es hexagonal: domain / application / infrastructure / adapters).
    // Solo se conocen por su `public.ts`; entre sí se comunican por eventos.
    IdentityModule, // usuarios y control de acceso (guard global)
    FleetModule,
    AssistanceModule,
    InspectionsModule,
    UploadsModule,
    HealthModule,

    // Entrega por WebSocket de lo que los módulos publican en Redis
    RealtimeModule,
    // Pendiente según el story map: ReportingModule (KPIs y dashboard)
  ],
})
export class AppModule {}
