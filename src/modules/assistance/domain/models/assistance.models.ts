import { UserRole } from '../../../../shared/domain/roles';

export type AssistanceKind = 'DRIVER_SUPPORT' | 'REPAIR';
export type CallStatus = 'OPEN' | 'FILLED' | 'COMPLETED';
export type IncidentReportStatus = 'REPORTED' | 'HELP_REQUESTED';
export type ClaimStatus = 'ACTIVE' | 'CANCELLED';

export interface DriverIncidentModel {
  id: string;
  busId: string;
  reportedById: string;
  /** Nombre de quien reportó, copiado al crear el incidente. */
  reportedByName: string | null;
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

/** Datos del bus que las pantallas muestran junto a cada alerta (vienen de `fleet`). */
export interface BusInfo {
  id: string;
  plate: string;
  /** Troncal o ruta. */
  route: string;
  locationLabel: string | null;
  latitude: number | null;
  longitude: number | null;
  driverName: string | null;
}

/** Datos del incidente que originó una alerta de apoyo (motivo, detalle y quién lo reportó). */
export interface IncidentInfo {
  id: string;
  type: string;
  description: string | null;
  reportedByName: string | null;
  createdAt: Date;
}

export interface CallView extends AssistanceCallModel {
  /** Admin: todas las aceptaciones. Conductor/mecánico: solo la suya. */
  claims: ClaimView[];
  bus: BusInfo | null;
  /** Solo en las alertas de apoyo de conductores. */
  incident: IncidentInfo | null;
}

export interface RepairExpense {
  concepto: string;
  valor: number;
}

/**
 * Informe del mecánico sobre una reparación. Es un borrador (editable) hasta que se finaliza;
 * al finalizar (`completedAt`) queda definitivo y cierra la alerta.
 */
export interface RepairReportModel {
  id: string;
  callId: string;
  mechanicId: string;
  mechanicName: string;
  damages: string;
  replacedParts: string;
  expenses: RepairExpense[];
  busPhotos: string[];
  partPhotos: string[];
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface RepairReportInput {
  damages: string;
  replacedParts: string;
  expenses: RepairExpense[];
  busPhotos: string[];
  partPhotos: string[];
}

export type SaveReportFailure = 'REPORT_FINALIZED' | 'CALL_CLOSED';

export type SaveReportResult =
  | { ok: true; report: RepairReportModel; completion: CompleteResult | null }
  | { ok: false; reason: SaveReportFailure };

export interface AssistanceSummary {
  incidentsLast24h: number;
  openSupportCalls: number;
  openRepairCalls: number;
  repairsInProgress: number;
  repairsCompletedLast24h: number;
  openBlockages: number;
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
