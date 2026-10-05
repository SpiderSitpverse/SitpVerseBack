import { ForbiddenError } from '../../../shared/domain/errors';
import { UserRole } from '../../../shared/domain/roles';
import {
  AssistanceCallModel,
  CancelFailure,
  ClaimFailure,
  ClaimModel,
  DriverIncidentModel,
  ROLE_FOR_KIND,
} from './models/assistance.models';

/** Quien actúa. Estructural: no depende del módulo `identity`. */
export interface Actor {
  id: string;
  role: UserRole;
}

/**
 * Reglas de negocio de la asistencia. Son funciones puras: no tocan BD ni Redis,
 * así se prueban sin infraestructura y los casos de uso solo las orquestan.
 */

/** Cada tipo de alerta solo la puede aceptar un rol: apoyo → DRIVER, reparación → MECHANICAL. */
export function assertRoleCanAccept(call: AssistanceCallModel, actor: Actor): void {
  const required = ROLE_FOR_KIND[call.kind];
  if (actor.role !== required) {
    throw new ForbiddenError(
      `Esta alerta solo puede ser aceptada por usuarios con rol ${required}`,
    );
  }
}

/** Quien reportó el incidente no puede cobrar la ayuda a su propio incidente. */
export function assertNotOwnIncident(incident: DriverIncidentModel | null, actor: Actor): void {
  if (incident?.reportedById === actor.id) {
    throw new ForbiddenError('No puedes aceptar la alerta de tu propio incidente');
  }
}

/**
 * Completar: el ADMIN siempre; en reparaciones también el mecánico que la tomó (aceptación
 * ACTIVA). Con cupos de apoyo solo cierra el ADMIN.
 */
export function assertCanComplete(
  call: AssistanceCallModel,
  actor: Actor,
  activeClaims: ClaimModel[],
): void {
  const isClaimer = activeClaims.some((claim) => claim.userId === actor.id);
  const allowed =
    actor.role === 'ADMIN' ||
    (call.kind === 'REPAIR' && actor.role === 'MECHANICAL' && isClaimer);
  if (!allowed) throw new ForbiddenError('No puedes completar esta alerta');
}

/** Una aceptación está vencida si sigue activa y ya pasó su plazo para llegar. */
export function isOverdue(claim: ClaimModel, now: Date = new Date()): boolean {
  return claim.status === 'ACTIVE' && claim.arriveBy.getTime() < now.getTime();
}

/** Mensaje para el cliente según por qué no se pudo tomar el cupo. */
export const CLAIM_FAILURE_MESSAGE: Record<ClaimFailure, string> = {
  NOT_FOUND: 'La alerta no existe',
  CLOSED: 'La alerta ya fue completada',
  FULL: 'Los cupos de esta alerta ya fueron tomados',
  ALREADY_CLAIMED: 'Ya aceptaste esta alerta',
  CANCELLED: 'Tu aceptación de esta alerta fue cancelada por administración',
};

export const CANCEL_FAILURE_MESSAGE: Record<CancelFailure, string> = {
  NOT_FOUND: 'La aceptación no existe',
  NOT_ACTIVE: 'La aceptación ya estaba cancelada',
  COMPLETED: 'La alerta ya fue completada; no se puede cancelar',
};
