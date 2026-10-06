import { UserRole } from '../../../../shared/domain/roles';

export const USER_ADMIN_REPOSITORY = Symbol('USER_ADMIN_REPOSITORY');

/** Lo que se muestra de un usuario en la administración. Nunca incluye la contraseña ni su hash. */
export interface UserView {
  id: string;
  employeeId: string;
  name: string;
  role: UserRole;
  active: boolean;
  createdAt: Date;
}

export interface NewUser {
  employeeId: string;
  name: string;
  role: UserRole;
  passwordHash: string;
}

/** Puerto de ADMINISTRACIÓN de usuarios (crear, editar, desactivar). Ve también las cuentas inactivas. */
export interface UserAdminRepositoryPort {
  list(): Promise<UserView[]>;
  /** Busca por id entre TODAS las cuentas (activas e inactivas). */
  findUserView(id: string): Promise<UserView | null>;
  create(data: NewUser): Promise<UserView>;
  update(id: string, data: { name?: string; role?: UserRole; active?: boolean }): Promise<UserView>;
  setPasswordHash(id: string, passwordHash: string): Promise<void>;
  /** Cuántos administradores activos hay (para no quedarse sin ninguno). */
  countActiveAdmins(): Promise<number>;
}
