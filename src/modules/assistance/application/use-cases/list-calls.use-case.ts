import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../../../identity/public';
import {
  ASSISTANCE_REPOSITORY,
  AssistanceRepositoryPort,
} from '../../domain/ports/assistance-repository.port';
import { isOverdue } from '../../domain/assistance.policy';
import { CallStatus, CallView, ROLE_FOR_KIND } from '../../domain/models/assistance.models';

/**
 * Alertas visibles para el rol del usuario (el admin ve todas), con sus aceptaciones y la
 * cuenta regresiva (`arriveBy`, `overdue`). También es la vía de RECONCILIACIÓN del front:
 * al conectarse o reconectarse consulta esto para conocer el estado real.
 *
 *  - ADMIN: todas las aceptaciones de cada alerta (para vigilar plazos y cancelar).
 *  - Conductor/mecánico: solo la suya.
 */
@Injectable()
export class ListCallsUseCase {
  constructor(
    @Inject(ASSISTANCE_REPOSITORY) private readonly repo: AssistanceRepositoryPort,
  ) {}

  async execute(actor: AuthenticatedUser, status?: CallStatus): Promise<CallView[]> {
    const all = await this.repo.listCalls({ status });
    const calls = actor.role === 'ADMIN' ? all : all.filter((c) => ROLE_FOR_KIND[c.kind] === actor.role);
    const claims = await this.repo.listClaims(calls.map((c) => c.id));
    const now = new Date();

    return calls.map((call) => ({
      ...call,
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
