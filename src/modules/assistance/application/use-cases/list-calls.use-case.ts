import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../../../identity/public';
import {
  ASSISTANCE_REPOSITORY,
  AssistanceRepositoryPort,
} from '../../domain/ports/assistance-repository.port';
import { BUS_DIRECTORY, BusDirectoryPort } from '../../domain/ports/bus-directory.port';
import { isOverdue } from '../../domain/assistance.policy';
import { CallStatus, CallView, ROLE_FOR_KIND } from '../../domain/models/assistance.models';

/**
 * Alertas visibles para el rol del usuario (el admin ve todas), con sus aceptaciones y la
 * cuenta regresiva (`arriveBy`, `overdue`). También es la vía de RECONCILIACIÓN del front:
 * al conectarse o reconectarse consulta esto para conocer el estado real.
 *
 *  - ADMIN: todas las alertas y todas las aceptaciones de cada una (para vigilar plazos y cancelar).
 *  - Conductor/mecánico: solo las alertas ABIERTAS, las que él tomó y (el conductor) las de su propio bus;
 *    una alerta que otro ya tomó se quita de su lista. De cada alerta ve solo su propia aceptación.
 *
 * Cada alerta trae además `bus` (placa, troncal, ubicación) y, en las de apoyo, `incident` (motivo,
 * detalle y quién lo reportó): lo que las pantallas pintan sin pedir nada más.
 */
@Injectable()
export class ListCallsUseCase {
  constructor(
    @Inject(ASSISTANCE_REPOSITORY) private readonly repo: AssistanceRepositoryPort,
    @Inject(BUS_DIRECTORY) private readonly buses: BusDirectoryPort,
  ) {}

  async execute(actor: AuthenticatedUser, status?: CallStatus): Promise<CallView[]> {
    const all = await this.repo.listCalls({ status });
    const ofRole = actor.role === 'ADMIN' ? all : all.filter((c) => ROLE_FOR_KIND[c.kind] === actor.role);
    const [allClaims, myBus] = await Promise.all([
      this.repo.listClaims(ofRole.map((c) => c.id)),
      actor.role === 'DRIVER' ? this.buses.findBusOfDriver(actor.id) : Promise.resolve(null),
    ]);

    // Una alerta que otro YA TOMÓ (cupos completos) o que ya terminó "se quita" para el resto: conductores y
    // mecánicos solo ven las abiertas, las que ellos mismos tomaron y, el conductor, las de su propio bus
    // (para saber que le llegó ayuda). El admin las ve todas.
    const iClaimed = new Set(allClaims.filter((cl) => cl.userId === actor.id).map((cl) => cl.callId));
    const calls =
      actor.role === 'ADMIN'
        ? ofRole
        : ofRole.filter((c) => c.status === 'OPEN' || iClaimed.has(c.id) || (myBus !== null && c.busId === myBus.id));
    const claims = allClaims.filter((cl) => calls.some((c) => c.id === cl.callId));

    const [buses, incidents] = await Promise.all([
      this.buses.describe(calls.map((c) => c.busId)),
      this.repo.findIncidentInfos(calls.flatMap((c) => (c.incidentId ? [c.incidentId] : []))),
    ]);
    const now = new Date();

    return calls.map((call) => ({
      ...call,
      bus: buses.get(call.busId) ?? null,
      incident: call.incidentId ? incidents.get(call.incidentId) ?? null : null,
      claims: claims
        .filter((claim) => claim.callId === call.id)
        .filter((claim) => actor.role === 'ADMIN' || claim.userId === actor.id)
        .map((claim) => ({
          ...claim,
          overdue: call.status !== 'COMPLETED' && isOverdue(claim, now),
        })),
    }));
  }
}
