import { AuthenticatedUser } from '../models/authenticated-user';

export const USER_DIRECTORY = Symbol('USER_DIRECTORY');

export interface UserWithCredentials {
  user: AuthenticatedUser;
  /** Hash de la contraseña. Solo sale de aquí para compararlo en el login; nunca viaja al cliente. */
  passwordHash: string;
}

/**
 * Puerto de AUTENTICACIÓN: de dónde salen los usuarios que pueden entrar (hoy Postgres;
 * mañana el sistema de empleados real). Solo devuelve cuentas ACTIVAS: una cuenta
 * desactivada deja de existir para el login y para los tokens ya emitidos.
 */
export interface UserDirectoryPort {
  findById(id: string): Promise<AuthenticatedUser | null>;
  findCredentialsByEmployeeId(employeeId: string): Promise<UserWithCredentials | null>;
  /** Hash actual de un usuario activo (para verificar su contraseña antes de cambiarla). */
  findPasswordHash(id: string): Promise<string | null>;
}
