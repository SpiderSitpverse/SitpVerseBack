import { UserRole } from '../../../../shared/domain/roles';

/** Quién está haciendo la petición. Es lo único de `identity` que los demás módulos necesitan conocer. */
export interface AuthenticatedUser {
  id: string;
  employeeId: string;
  name: string;
  role: UserRole;
}
