import { UserRole } from '../../../../shared/domain/roles';
import { AuditEntry } from './audit-log.port';

export const USER_ADMIN_REPOSITORY = Symbol('USER_ADMIN_REPOSITORY');

/** Lo que se muestra de un usuario en la administración. */
export interface UserView {
  id: string;
  employeeId: string;
  name: string;
  role: UserRole;
  email: string;
  photoUrl: string | null;
  active: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface NewUser {
  employeeId: string;
  name: string;
  role: UserRole;
  email: string;
}

export interface UserChange {
  name?: string;
  role?: UserRole;
  email?: string;
  active?: boolean;
}

/**
 * Puerto de ADMINISTRACIÓN de usuarios (prerregistrar, editar, desactivar). Ve también las cuentas inactivas.
 * Cada cambio recibe su entrada de auditoría y el adaptador la guarda en la MISMA transacción: no puede existir el
 * cambio sin su registro.
 */
export interface UserAdminRepositoryPort {
  list(): Promise<UserView[]>;
  /** Busca por id entre TODAS las cuentas (activas e inactivas). */
  findUserView(id: string): Promise<UserView | null>;
  create(data: NewUser, audit: (created: UserView) => AuditEntry): Promise<UserView>;
  update(id: string, data: UserChange, audit: (updated: UserView) => AuditEntry): Promise<UserView>;
  /** Cuántos administradores activos hay (para no quedarse sin ninguno). */
  countActiveAdmins(): Promise<number>;
}
