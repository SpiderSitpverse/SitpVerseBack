import { UserRole } from '../../../../shared/domain/roles';

export const AUDIT_LOG = Symbol('AUDIT_LOG');

export type AuditOutcome = 'SUCCESS' | 'DENIED' | 'FAILURE';

/** Una acción crítica: quién, qué, sobre qué, cuándo (lo pone la base), desde dónde y con qué resultado. */
export interface AuditEntry {
  action: string;
  outcome: AuditOutcome;
  actorId?: string | null;
  actorEmail?: string | null;
  actorSub?: string | null;
  actorRole?: UserRole | null;
  resourceType?: string | null;
  resourceId?: string | null;
  ip?: string | null;
  /** Navegador y país: si faltan, se toman de la petición en curso (ver `auditData`). */
  userAgent?: string | null;
  country?: string | null;
  traceId?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface AuditRecord extends AuditEntry {
  id: string;
  at: Date;
}

export interface AuditQuery {
  action?: string;
  actorId?: string;
  resourceType?: string;
  resourceId?: string;
  outcome?: AuditOutcome;
  from?: Date;
  to?: Date;
  limit: number;
  /** Paginación: registros anteriores a esta marca de tiempo. */
  before?: Date;
}

/**
 * Puerto de AUDITORÍA (solo inserción). Lo implementa identity (dueño de la tabla) y los demás módulos lo reciben
 * por `public.ts`. No ofrece ninguna operación que modifique o borre registros.
 */
export interface AuditLogPort {
  record(entry: AuditEntry): Promise<void>;
  list(query: AuditQuery): Promise<AuditRecord[]>;
}
