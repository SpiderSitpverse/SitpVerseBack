import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/public';
import { FleetController } from './adapters/http/fleet.controller';
import { FleetHomeController } from './adapters/http/fleet-home.controller';
import { FleetSummaryController } from './adapters/http/fleet-summary.controller';
import { SimulatedFleetFeed } from './adapters/feed/simulated-fleet-feed.adapter';
import { BusAccessService } from './application/services/bus-access.service';
import { FleetQueryService } from './application/services/fleet-query.service';
import {
  AssignDriverUseCase,
  CreateBusUseCase,
  GetFleetSummaryUseCase,
  UpdateBusDetailsUseCase,
} from './application/use-cases/manage-buses.use-cases';
import { FinishTripUseCase } from './application/use-cases/finish-trip.use-case';
import { GetBusDetailUseCase } from './application/use-cases/get-bus-detail.use-case';
import { GetOperativeHomeUseCase } from './application/use-cases/get-operative-home.use-case';
import { ListBusesUseCase } from './application/use-cases/list-buses.use-case';
import { StartTripUseCase } from './application/use-cases/start-trip.use-case';
import { UpdateBusPositionUseCase } from './application/use-cases/update-bus-position.use-case';
import { BUS_REPOSITORY } from './domain/ports/bus-repository.port';
import { DRIVER_DIRECTORY } from './domain/ports/driver-directory.port';
import { POSITION_PUBLISHER } from './domain/ports/position-publisher.port';
import { IdentityDriverDirectory } from './infrastructure/identity/identity-driver-directory.adapter';
import { PrismaBusRepository } from './infrastructure/prisma/bus.repository';
import { RedisPositionPublisher } from './infrastructure/redis/redis-position-publisher';

/**
 * Flota: estado y posición de los buses en tiempo real.
 * Prisma y Redis llegan del SharedModule (global).
 */
@Module({
  imports: [IdentityModule], // para verificar que el conductor asignado existe (por su API pública)
  controllers: [FleetController, FleetHomeController, FleetSummaryController],
  providers: [
    // Casos de uso
    ListBusesUseCase,
    GetBusDetailUseCase,
    StartTripUseCase,
    UpdateBusPositionUseCase,
    FinishTripUseCase,
    GetOperativeHomeUseCase,
    CreateBusUseCase,
    UpdateBusDetailsUseCase,
    AssignDriverUseCase,
    GetFleetSummaryUseCase,

    // Servicios de aplicación
    BusAccessService,
    FleetQueryService, // API de lectura para otros módulos (ver public.ts)

    // Entrada de posiciones: hoy simulada, mañana la API real de TransMilenio
    SimulatedFleetFeed,

    // Puerto → adapter (la pieza clave de hexagonal en Nest)
    { provide: BUS_REPOSITORY, useClass: PrismaBusRepository },
    { provide: POSITION_PUBLISHER, useClass: RedisPositionPublisher },
    { provide: DRIVER_DIRECTORY, useClass: IdentityDriverDirectory },
  ],
  exports: [FleetQueryService],
})
export class FleetModule {}
