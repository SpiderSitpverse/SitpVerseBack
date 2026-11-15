import { CallHandler, ExecutionContext, HttpException, Inject, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, catchError, from, mergeMap, throwError } from 'rxjs';
import { ForbiddenError, UnauthorizedError } from '../../../../shared/domain/errors';
import { currentRequestContext } from '../../../../shared/http/client-info';
import { AUDIT_LOG, AuditLogPort } from '../../domain/ports/audit-log.port';
import { AUDITED_KEY, AuditedRequest, AuditedSpec, auditEntryOf } from './audited';

const DENIED_STATUS = new Set([401, 403]);

/** ¿El error es un rechazo de acceso (DENIED) o un fallo de la acción (FAILURE)? */
function isDenied(error: unknown): boolean {
  if (error instanceof ForbiddenError || error instanceof UnauthorizedError) return true;
  return error instanceof HttpException && DENIED_STATUS.has(error.getStatus());
}

/**
 * Interceptor GLOBAL de auditoría (ESC-SEG-03). Para cada ruta `@Audited`:
 *   1. Antes de ejecutar deja el registro PENDIENTE en el contexto de la petición: los adaptadores lo insertan dentro de
 *      la transacción del cambio (ver `shared/infrastructure/pending-audit.ts`).
 *   2. Si la acción termina bien, lo asegura (idempotente: si ya se insertó en la transacción, no se duplica).
 *   3. Si la acción falla o se rechaza, registra el intento con resultado DENIED o FAILURE.
 * Las rutas sin `@Audited` no pagan nada.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(AUDIT_LOG) private readonly audit: AuditLogPort,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const spec = this.reflector.get<AuditedSpec | undefined>(AUDITED_KEY, ctx.getHandler());
    if (!spec) return next.handle();

    const request = ctx.switchToHttp().getRequest<AuditedRequest>();
    const pending = this.audit.prepare(auditEntryOf(spec, request, 'SUCCESS'));
    const context = currentRequestContext();
    if (context) context.audit = pending;

    return next.handle().pipe(
      mergeMap(async (body) => {
        await this.audit.confirm(pending);
        return body;
      }),
      catchError((error) => from(this.recordFailure(spec, request, error)).pipe(mergeMap(() => throwError(() => error)))),
    );
  }

  private async recordFailure(spec: AuditedSpec, request: AuditedRequest, error: unknown): Promise<void> {
    const context = currentRequestContext();
    if (context) context.audit = undefined; // la transacción se revirtió: el registro de éxito ya no aplica
    const reason =
      error instanceof Error ? { error: error.name, message: error.message.slice(0, 300) } : { error: 'Error' };
    try {
      await this.audit.record(auditEntryOf(spec, request, isDenied(error) ? 'DENIED' : 'FAILURE', undefined, reason));
    } catch (failure) {
      // Un fallo al auditar no debe tapar el error original, pero SÍ queda a la vista en el log.
      this.logger.error(JSON.stringify({ event: 'audit.write_failed', severity: 'ERROR', error: String(failure) }));
    }
  }
}
