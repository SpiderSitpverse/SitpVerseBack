import { ConflictError, InvalidInputError } from '../../../shared/domain/errors';
import { UserRole } from '../../../shared/domain/roles';
import { UserView } from './ports/user-admin-repository.port';

/** Reglas de negocio de la administración de usuarios (funciones puras, sin infraestructura). */

const EMPLOYEE_ID = /^[A-Za-z0-9._-]{3,32}$/;

export function assertValidEmployeeId(employeeId: string): void {
  if (!EMPLOYEE_ID.test(employeeId)) {
    throw new InvalidInputError(
      'El número de empleado debe tener de 3 a 32 caracteres: letras, números, punto, guion o guion bajo',
    );
  }
}

const MAX_EMAIL_LENGTH = 254;

/** `algo@dominio.tld`: sin espacios, una sola arroba y un punto en el dominio (que no sea ni primero ni último). */
function looksLikeEmail(email: string): boolean {
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@') || /\s/.test(email)) return false;
  const domain = email.slice(at + 1);
  return domain.length > 2 && domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function assertValidEmail(email: string): void {
  const value = normalizeEmail(email);
  if (value.length > MAX_EMAIL_LENGTH || !looksLikeEmail(value)) {
    throw new InvalidInputError('Escribe un correo válido (el de la cuenta de Google de la persona)');
  }
}

/**
 * Un administrador no puede quitarse a sí mismo el acceso (desactivarse o bajarse de rol), y
 * nunca puede quedar el sistema sin un administrador activo: nadie podría volver a gestionarlo.
 */
export function assertCanChangeAccess(
  actorId: string,
  target: UserView,
  change: { role?: UserRole; active?: boolean },
  activeAdmins: number,
): void {
  const losesAdminAccess =
    target.role === 'ADMIN' &&
    target.active &&
    (change.active === false || (change.role !== undefined && change.role !== 'ADMIN'));
  if (!losesAdminAccess) return;

  if (target.id === actorId) {
    throw new ConflictError('No puedes desactivar tu propia cuenta ni quitarte el rol de administrador', {
      reason: 'SELF_LOCKOUT',
    });
  }
  if (activeAdmins <= 1) {
    throw new ConflictError('Debe quedar al menos un administrador activo', { reason: 'LAST_ADMIN' });
  }
}
