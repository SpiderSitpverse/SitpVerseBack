import { Module } from '@nestjs/common';
import { FleetModule } from '../fleet/public';
import { AssistanceController } from './adapters/http/assistance.controller';
import { AcceptCallUseCase } from './application/use-cases/accept-call.use-case';
import { CancelClaimUseCase } from './application/use-cases/cancel-claim.use-case';
import { CompleteCallUseCase } from './application/use-cases/complete-call.use-case';
import { GetMyProfileUseCase } from './application/use-cases/get-my-profile.use-case';
import { ListCallsUseCase } from './application/use-cases/list-calls.use-case';
import { ListIncidentsUseCase } from './application/use-cases/list-incidents.use-case';
import { ReportBusFaultUseCase } from './application/use-cases/report-bus-fault.use-case';
import { ReportDriverIncidentUseCase } from './application/use-cases/report-driver-incident.use-case';
import { RequestDriverSupportUseCase } from './application/use-cases/request-driver-support.use-case';
import { ResendCallUseCase } from './application/use-cases/resend-call.use-case';
import { ASSISTANCE_REPOSITORY } from './domain/ports/assistance-repository.port';
import { BUS_DIRECTORY } from './domain/ports/bus-directory.port';
import { FleetBusDirectory } from './infrastructure/fleet/fleet-bus-directory.adapter';
import { PrismaAssistanceRepository } from './infrastructure/prisma/assistance.repository';

/**
 * Asistencia: alertas con cupos aceptadas de forma concurrente
 * (apoyo de conductores y reparación por mecánicos).
 *
 * Prisma, Redis, el lock FIFO y el outbox llegan del SharedModule (global); la flota,
 * por la API pública de `fleet`.
 */
@Module({
  imports: [FleetModule],
  controllers: [AssistanceController],
  providers: [
    // Casos de uso
    ReportDriverIncidentUseCase,
    RequestDriverSupportUseCase,
    ReportBusFaultUseCase,
    AcceptCallUseCase,
    CancelClaimUseCase,
    ResendCallUseCase,
    CompleteCallUseCase,
    ListIncidentsUseCase,
    ListCallsUseCase,
    GetMyProfileUseCase,

    // Puerto → adapter
    { provide: ASSISTANCE_REPOSITORY, useClass: PrismaAssistanceRepository },
    { provide: BUS_DIRECTORY, useClass: FleetBusDirectory },
  ],
})
export class AssistanceModule {}
