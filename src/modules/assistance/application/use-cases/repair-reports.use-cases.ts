import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ConflictError, NotFoundError } from '../../../../shared/domain/errors';
import { AuthenticatedUser } from '../../../identity/public';
import {
  ASSISTANCE_REPOSITORY,
  AssistanceRepositoryPort,
} from '../../domain/ports/assistance-repository.port';
import { BUS_DIRECTORY, BusDirectoryPort } from '../../domain/ports/bus-directory.port';
import {
  assertCanFinalize,
  assertCanReadReport,
  assertCanWriteReport,
  normalizeReport,
} from '../../domain/repair-report.policy';
import { RepairReportInput } from '../../domain/models/assistance.models';
import { callCompletedEvents } from '../assistance-event.factory';

/**
 * El mecánico que tiene el servicio guarda su informe (borrador, tantas veces como quiera) o lo
 * FINALIZA. Finalizar cierra la alerta y acredita el bono en la MISMA transacción: no puede quedar
 * un informe definitivo con la reparación abierta, ni una reparación cerrada sin informe.
 */
@Injectable()
export class SaveRepairReportUseCase {
  constructor(
    @Inject(ASSISTANCE_REPOSITORY) private readonly repo: AssistanceRepositoryPort,
  ) {}

  async execute(
    actor: AuthenticatedUser,
    callId: string,
    input: Partial<Record<keyof RepairReportInput, unknown>>,
    finalize: boolean,
    traceId = randomUUID(),
  ) {
    const call = await this.repo.findCall(callId);
    if (!call) throw new NotFoundError(`Alerta ${callId} no encontrada`);

    const activeClaims = (await this.repo.listClaims([callId])).filter((c) => c.status === 'ACTIVE');
    assertCanWriteReport(call, actor, activeClaims);

    const report = normalizeReport(input);
    if (finalize) assertCanFinalize(report);

    const result = await this.repo.saveRepairReport(
      callId,
      { id: actor.id, name: actor.name },
      report,
      finalize,
      ({ call: closed, awardedUserIds }) => callCompletedEvents(traceId, closed, awardedUserIds),
    );

    if (!result.ok) {
      throw new ConflictError(
        result.reason === 'REPORT_FINALIZED'
          ? 'El informe ya fue finalizado y no admite cambios'
          : 'La alerta ya fue completada',
        { reason: result.reason },
      );
    }
    return {
      traceId,
      report: result.report,
      completed: result.completion !== null,
      pointsAwardedTo: result.completion?.awardedUserIds ?? [],
    };
  }
}

/** El informe de una reparación (admin cualquiera; el mecánico, solo los suyos). */
@Injectable()
export class GetRepairReportUseCase {
  constructor(@Inject(ASSISTANCE_REPOSITORY) private readonly repo: AssistanceRepositoryPort) {}

  async execute(actor: AuthenticatedUser, callId: string) {
    const report = await this.repo.findRepairReport(callId);
    if (!report) throw new NotFoundError('Esta reparación todavía no tiene informe');
    assertCanReadReport(actor, report);
    return report;
  }
}

/** Historial de informes (pantallas "Mis reparaciones" y "Mantenimiento"), con los datos del bus. */
@Injectable()
export class ListRepairReportsUseCase {
  constructor(
    @Inject(ASSISTANCE_REPOSITORY) private readonly repo: AssistanceRepositoryPort,
    @Inject(BUS_DIRECTORY) private readonly buses: BusDirectoryPort,
  ) {}

  async execute(actor: AuthenticatedUser) {
    const reports = await this.repo.listRepairReports({
      mechanicId: actor.role === 'MECHANICAL' ? actor.id : undefined,
    });
    const calls = await Promise.all(reports.map((r) => this.repo.findCall(r.callId)));
    const buses = await this.buses.describe(calls.flatMap((c) => (c ? [c.busId] : [])));

    return reports.map((report, i) => ({
      ...report,
      call: calls[i] && {
        id: calls[i]!.id,
        description: calls[i]!.description,
        status: calls[i]!.status,
        busId: calls[i]!.busId,
      },
      bus: calls[i] ? buses.get(calls[i]!.busId) ?? null : null,
    }));
  }
}

/** Números para el panel del administrador (incidentes, alertas abiertas, reparaciones...). */
@Injectable()
export class GetAssistanceSummaryUseCase {
  constructor(@Inject(ASSISTANCE_REPOSITORY) private readonly repo: AssistanceRepositoryPort) {}

  execute() {
    return this.repo.summary();
  }
}
