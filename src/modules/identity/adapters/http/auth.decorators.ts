import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { UserRole } from '../../../../shared/domain/roles';
import { AuthenticatedUser } from '../../domain/models/authenticated-user';

export const ROLES_KEY = 'auth:roles';
export const PUBLIC_KEY = 'auth:public';

/**
 * Roles que pueden usar la ruta. Es OBLIGATORIO declararlo: una ruta sin `@Roles(...)` ni
 * `@Public()` se rechaza (el sistema falla cerrado, no abierto).
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** Ruta sin autenticación (p. ej. health check). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Inyecta el usuario autenticado en el handler. */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthenticatedUser =>
    ctx.switchToHttp().getRequest().user,
);
