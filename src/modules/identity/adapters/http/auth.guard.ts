import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../../../shared/domain/roles';
import { AuthenticateEmployeeUseCase } from '../../application/authenticate-employee.use-case';
import { PUBLIC_KEY, ROLES_KEY } from './auth.decorators';

/**
 * Guard GLOBAL (se registra una vez en IdentityModule vía APP_GUARD): protege TODAS las rutas.
 *
 *   1. `@Public()`            → pasa.
 *   2. Sin usuario válido      → 401.
 *   3. Sin `@Roles(...)`       → 403 (falla cerrado: una ruta nueva olvidada no queda abierta).
 *   4. Rol no permitido        → 403.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authenticate: AuthenticateEmployeeUseCase,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true; // los sockets se autentican en el gateway

    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const request = ctx.switchToHttp().getRequest();
    const header = request.headers['x-employee-id'];
    const user = await this.authenticate.execute(typeof header === 'string' ? header : undefined);
    if (!user) throw new UnauthorizedException('Falta o es inválido el header x-employee-id');

    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, targets);
    if (!roles) throw new ForbiddenException('La ruta no declara una política de acceso');
    if (!roles.includes(user.role)) {
      throw new ForbiddenException(`Tu rol (${user.role}) no puede realizar esta acción`);
    }

    request.user = user;
    return true;
  }
}
