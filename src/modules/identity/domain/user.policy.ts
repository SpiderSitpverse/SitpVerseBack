import { ConflictError, InvalidInputError } from '../../../shared/domain/errors';
import { UserRole } from '../../../shared/domain/roles';
import { UserView } from './ports/user-admin-repository.port';

/** Reglas de negocio de la administración de usuarios (funciones puras, sin infraestructura). */

export const MIN_PASSWORD_LENGTH = 8;
const EMPLOYEE_ID = /^[A-Za-z0-9._-]{3,32}$/;

export function assertValidEmployeeId(employeeId: string): void {
  if (!EMPLOYEE_ID.test(employeeId)) {
    throw new InvalidInputError(
      'El número de empleado debe tener de 3 a 32 caracteres: letras, números, punto, guion o guion bajo',
    );
  }
}

export function assertStrongEnoughPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new InvalidInputError(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`, {
      reason: 'WEAK_PASSWORD',
    });
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new InvalidInputError('La contraseña debe combinar letras y números', { reason: 'WEAK_PASSWORD' });
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
