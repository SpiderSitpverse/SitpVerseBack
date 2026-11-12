import { AuthenticatedUser } from '../models/authenticated-user';
import { AuditEntry } from './audit-log.port';

export const USER_DIRECTORY = Symbol('USER_DIRECTORY');

/** Datos que Google aporta y que se copian al usuario en cada ingreso. */
export interface GoogleProfile {
  subject: string;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
}

/**
 * Puerto de AUTENTICACIÓN: de dónde salen los usuarios que pueden entrar (hoy Postgres;
 * mañana el sistema de empleados real). Solo devuelve cuentas ACTIVAS: una cuenta
 * desactivada deja de existir para el login y para los tokens ya emitidos.
 */
export interface UserDirectoryPort {
  findById(id: string): Promise<AuthenticatedUser | null>;
  findByGoogleSubject(subject: string): Promise<AuthenticatedUser | null>;
  /** Cuenta ACTIVA prerregistrada con este correo que todavía no está vinculada a ninguna cuenta de Google. */
  findUnlinkedByEmail(email: string): Promise<AuthenticatedUser | null>;
  /** true si existe una cuenta DESACTIVADA de esta persona (por su `sub` o su correo). */
  isDisabledAccount(subject: string, email: string): Promise<boolean>;
  /**
   * Guarda el `sub` (si falta), actualiza nombre y foto con los de Google, anota el último ingreso y registra la
   * auditoría, todo en UNA transacción. Es condicional: si la cuenta ya está vinculada a OTRA cuenta de Google, o se
   * desactivó en este instante, devuelve null (dos primeros ingresos simultáneos no pueden vincular dos cuentas).
   */
  recordGoogleLogin(id: string, profile: GoogleProfile, audit: AuditEntry): Promise<AuthenticatedUser | null>;
}
