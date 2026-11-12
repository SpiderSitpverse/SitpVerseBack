import { UserRole } from '../../../../shared/domain/roles';
import { AuditEntry } from './audit-log.port';
import { UserView } from './user-admin-repository.port';

export const ACCESS_REQUEST_REPOSITORY = Symbol('ACCESS_REQUEST_REPOSITORY');

export type AccessRequestStatus = 'PENDING' | 'REJECTED';

export interface AccessRequestView {
  id: string;
  email: string;
  name: string;
  photoUrl: string | null;
  status: AccessRequestStatus;
  requestedAt: Date;
  lastAttemptAt: Date;
}

/** Lo que Google afirma de quien pide acceso. */
export interface AccessApplicant {
  subject: string;
  email: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
}

export interface RecordedRequest {
  request: AccessRequestView;
  /** true si es la PRIMERA vez que esta persona pide acceso. */
  created: boolean;
}

/**
 * Puerto de SOLICITUDES DE ACCESO: quien entra con Google sin tener cuenta queda en espera, sin rol ni sesión, hasta que
 * un administrador la acepte (y le dé un rol) o la rechace.
 */
export interface AccessRequestRepositoryPort {
  /**
   * Registra (o refresca) la solicitud de esta persona. Es seguro frente a intentos simultáneos: la base de datos
   * garantiza una sola fila por correo y por cuenta de Google. Devuelve null si ya hay demasiadas solicitudes abiertas
   * (para que nadie llene la tabla) y la persona no tenía una.
   */
  record(applicant: AccessApplicant, maxOpen: number, audit: (request: AccessRequestView) => AuditEntry): Promise<RecordedRequest | null>;
  list(): Promise<AccessRequestView[]>;
  findById(id: string): Promise<AccessRequestView | null>;
  /**
   * Acepta la solicitud: en UNA transacción crea el usuario (con la cuenta de Google ya vinculada), borra la solicitud
   * y deja la auditoría. Dos admins aceptando a la vez: solo uno lo logra. `employeeId` vacío = el siguiente número
   * libre del rol.
   */
  approve(
    id: string,
    data: { role: UserRole; employeeId?: string; name?: string },
    audit: (user: UserView) => AuditEntry,
  ): Promise<UserView | null>;
  /** Marca la solicitud como rechazada. Devuelve false si ya no existe. */
  reject(id: string, actorId: string, audit: AuditEntry): Promise<boolean>;
}
