import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FleetController } from './adapters/http/fleet.controller';
import { FleetHomeController } from './adapters/http/fleet-home.controller';
import { FleetSimulatorService } from './adapters/simulation/fleet-simulator.service';
import { ListBusesUseCase } from './application/use-cases/list-buses.use-case';
import { GetBusDetailUseCase } from './application/use-cases/get-bus-detail.use-case';
import { StartTripUseCase } from './application/use-cases/start-trip.use-case';
import { UpdateBusPositionUseCase } from './application/use-cases/update-bus-position.use-case';
import { FinishTripUseCase } from './application/use-cases/finish-trip.use-case';
import { GetOperativeHomeUseCase } from './application/use-cases/get-operative-home.use-case';
import { BUS_REPOSITORY } from './domain/ports/bus-repository.port';
import { POSITION_PUBLISHER } from './domain/ports/position-publisher.port';
import { PrismaBusRepository } from './infrastructure/prisma/bus.repository';
import { RedisPositionPublisher } from './infrastructure/redis/redis-position-publisher';
import { PrismaService } from '../../shared/infrastructure/prisma.service';
import { RedisPublisherProvider } from '../../shared/infrastructure/redis.provider';

@Module({
  imports: [ConfigModule],
  controllers: [FleetController, FleetHomeController],
  providers: [
    PrismaService,
    RedisPublisherProvider,

    // Casos de uso
    ListBusesUseCase,
    GetBusDetailUseCase,
    StartTripUseCase,
    UpdateBusPositionUseCase,
    FinishTripUseCase,
    GetOperativeHomeUseCase,

    // Adapter que simula el feed externo (ver adapters/simulation)
    FleetSimulatorService,

    // Bindings puerto -> adapter concreto (esto es LA pieza clave de hexagonal en Nest)
    { provide: BUS_REPOSITORY, useClass: PrismaBusRepository },
    { provide: POSITION_PUBLISHER, useClass: RedisPositionPublisher },
  ],
  exports: [BUS_REPOSITORY],
})
export class FleetModule {}