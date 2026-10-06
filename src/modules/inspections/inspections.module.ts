import { Module } from '@nestjs/common';
import { FleetModule } from '../fleet/public';
import { InspectionsController } from './adapters/http/inspections.controller';
import {
  CreateInspectionUseCase,
  GetLatestInspectionUseCase,
  ListInspectionsUseCase,
} from './application/use-cases/inspections.use-cases';
import { INSPECTION_BUS_DIRECTORY } from './domain/ports/bus-directory.port';
import { INSPECTION_REPOSITORY } from './domain/ports/inspection-repository.port';
import { FleetInspectionBusDirectory } from './infrastructure/fleet/fleet-bus-directory.adapter';
import { PrismaInspectionRepository } from './infrastructure/prisma/inspection.repository';

/**
 * Inspección digital previa al viaje con fotos (Épica 3). Registros inmutables.
 * Prisma llega del SharedModule (global); la flota, por la API pública de `fleet`.
 */
@Module({
  imports: [FleetModule],
  controllers: [InspectionsController],
  providers: [
    CreateInspectionUseCase,
    GetLatestInspectionUseCase,
    ListInspectionsUseCase,
    { provide: INSPECTION_REPOSITORY, useClass: PrismaInspectionRepository },
    { provide: INSPECTION_BUS_DIRECTORY, useClass: FleetInspectionBusDirectory },
  ],
})
export class InspectionsModule {}
