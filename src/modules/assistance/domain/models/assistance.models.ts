import { UserRole } from '../../../../shared/domain/roles';

export type AssistanceKind = 'DRIVER_SUPPORT' | 'REPAIR';
export type CallStatus = 'OPEN' | 'FILLED' | 'COMPLETED';
export type IncidentReportStatus = 'REPORTED' | 'HELP_REQUESTED';
export type ClaimStatus = 'ACTIVE' | 'CANCELLED';

export interface DriverIncidentModel {
  id: string;
  busId: string;
  reportedById: string;
  type: string;
  description: string | null;
  status: IncidentReportStatus;
  createdAt: Date;
}

export interface AssistanceCallModel {
  id: string;
  kind: AssistanceKind;
  incidentId: string | null;
  busId: string;
  slots: number;
  /** Reclamos ACTIVOS (los cancelados liberan su cupo). */
  claimedCount: number;
  rewardPoints: number;
  status: CallStatus;
  createdById: string;
  description: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface ClaimModel {
  id: string;
  callId: string;
  userId: string;
  status: ClaimStatus;
  /** Bus desde el que se acude (solo conductores de apoyo). */
  busId: string | null;
  /** Plazo máximo para llegar. Si vence, el admin cancela la aceptación y reenvía la alerta. */
  arriveBy: Date;
  cancelledAt: Date | null;
  cancelledById: string | null;
  createdAt: Date;
}

export interface ClaimWithUser extends ClaimModel {
  userName: string;
}

/** Lo que ve un cliente: la aceptación con su cuenta regresiva. */
export interface ClaimView extends ClaimWithUser {
  /** true si está activa y ya pasó `arriveBy`: el admin debería cancelar y reenviar. */
  overdue: boolean;
}

export interface CallView extends AssistanceCallModel {
  /** Admin: todas las aceptaciones. Conductor/mecánico: solo la suya. */
  claims: ClaimView[];
}

/** Rol que debe poder aceptar cada tipo de alerta. */
export const ROLE_FOR_KIND: Record<AssistanceKind, UserRole> = {
  DRIVER_SUPPORT: 'DRIVER',
  REPAIR: 'MECHANICAL',
};

export type ClaimFailure =
  | 'NOT_FOUND'
  | 'CLOSED'
  | 'FULL'
  | 'ALREADY_CLAIMED'
  | 'CANCELLED';

export type ClaimResult =
  | { ok: true; call: AssistanceCallModel; claim: ClaimModel; filled: boolean }
  | { ok: false; reason: ClaimFailure };

export type CancelFailure = 'NOT_FOUND' | 'NOT_ACTIVE' | 'COMPLETED';

export type CancelResult =
  | { ok: true; call: AssistanceCallModel; claim: ClaimModel }
  | { ok: false; reason: CancelFailure };

export interface CompleteResult {
  call: AssistanceCallModel;
  awardedUserIds: string[];
}
