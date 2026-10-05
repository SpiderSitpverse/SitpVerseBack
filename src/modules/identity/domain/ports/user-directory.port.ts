import { AuthenticatedUser } from '../models/authenticated-user';

export const USER_DIRECTORY = Symbol('USER_DIRECTORY');

/** Puerto: de dónde salen los usuarios (hoy Postgres; mañana el sistema de empleados real). */
export interface UserDirectoryPort {
  findByEmployeeId(employeeId: string): Promise<AuthenticatedUser | null>;
}
