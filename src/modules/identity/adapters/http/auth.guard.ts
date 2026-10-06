import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../../../shared/domain/roles';
import { AuthenticateTokenUseCase } from '../../application/authenticate-token.use-case';
import { PUBLIC_KEY, ROLES_KEY } from './auth.decorators';

const BEARER = /^Bearer\s+(.+)$/i;

/**
 * Guard GLOBAL (se registra una vez en IdentityModule vía APP_GUARD): protege TODAS las rutas.
 *
 *   1. `@Public()`            → pasa.
 *   2. Sin token válido        → 401   (header `Authorization: Bearer <token>`).
 *   3. Sin `@Roles(...)`       → 403   (falla cerrado: una ruta nueva olvidada no queda abierta).
 *   4. Rol no permitido        → 403.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authenticate: AuthenticateTokenUseCase,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true; // los sockets se autentican en el gateway

    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const request = ctx.switchToHttp().getRequest();
    const token = BEARER.exec(request.headers['authorization'] ?? '')?.[1];
    const user = await this.authenticate.execute(token);
    if (!user) throw new UnauthorizedException('Token ausente, inválido o vencido');

    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, targets);
    if (!roles) throw new ForbiddenException('La ruta no declara una política de acceso');
    if (!roles.includes(user.role)) {
      throw new ForbiddenException(`Tu rol (${user.role}) no puede realizar esta acción`);
    }

    request.user = user;
    return true;
  }
}
