import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../../../shared/domain/roles';
import { AuthenticateTokenUseCase } from '../../application/authenticate-token.use-case';
import { AUDIT_LOG, AuditLogPort } from '../../domain/ports/audit-log.port';
import { PUBLIC_KEY, ROLES_KEY } from './auth.decorators';
import { AUDITED_KEY, AuditedSpec, auditEntryOf } from './audited';

const BEARER_PREFIX = 'bearer ';

/** Token de `Authorization: Bearer <token>` (el esquema no distingue mayúsculas); undefined si no hay. */
function bearerToken(header: string): string | undefined {
  const value = header.trim();
  if (value.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) return undefined;
  return value.slice(BEARER_PREFIX.length).trim() || undefined;
}

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
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly authenticate: AuthenticateTokenUseCase,
    @Inject(AUDIT_LOG) private readonly audit: AuditLogPort,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true; // los sockets se autentican en el gateway

    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const request = ctx.switchToHttp().getRequest();
    const token = bearerToken(request.headers['authorization'] ?? '');
    const user = await this.authenticate.execute(token);
    if (!user) throw new UnauthorizedException('Token ausente, inválido o vencido');

    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, targets);
    if (!roles) throw new ForbiddenException('La ruta no declara una política de acceso');
    if (!roles.includes(user.role)) {
      // Intentar una acción crítica sin el rol necesario también queda en la auditoría (ESC-SEG-03).
      const audited = this.reflector.get<AuditedSpec | undefined>(AUDITED_KEY, ctx.getHandler());
      if (audited) {
        await this.audit
          .record(auditEntryOf(audited, request, 'DENIED', user, { reason: 'ROLE_NOT_ALLOWED' }))
          .catch((error) =>
            this.logger.error(JSON.stringify({ event: 'audit.write_failed', severity: 'ERROR', error: String(error) })),
          );
      }
      throw new ForbiddenException(`Tu rol (${user.role}) no puede realizar esta acción`);
    }

    request.user = user;
    return true;
  }
}
