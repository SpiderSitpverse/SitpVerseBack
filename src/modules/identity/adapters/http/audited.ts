import { SetMetadata } from '@nestjs/common';
import { AuditEntry, AuditOutcome } from '../../domain/ports/audit-log.port';
import { AuthenticatedUser } from '../../domain/models/authenticated-user';

export const AUDITED_KEY = 'audit:action';

/** De dónde sale el id del recurso: `params.id`, `body.busId`... */
type ResourcePath = `params.${string}` | `body.${string}`;

export interface AuditedSpec {
  action: string;
  resourceType?: string;
  resourceFrom?: ResourcePath;
}

/**
 * Marca una ruta como ACCIÓN CRÍTICA (ESC-SEG-03): cada llamada deja un registro en `audit_log` con quién, qué, sobre
 * qué recurso, desde dónde, con qué resultado y con qué `trace_id`. Si la acción cambia la base, el registro se guarda
 * en la misma transacción que el cambio; los intentos rechazados o fallidos también quedan registrados.
 *
 *   @Audited('trip.start', 'bus', 'params.id')
 */
export const Audited = (action: string, resourceType?: string, resourceFrom?: ResourcePath) =>
  SetMetadata(AUDITED_KEY, { action, resourceType, resourceFrom } satisfies AuditedSpec);

export interface AuditedRequest {
  method: string;
  route?: { path?: string };
  params?: Record<string, unknown>;
  body?: Record<string, unknown>;
  user?: AuthenticatedUser;
}

function resourceIdOf(spec: AuditedSpec, request: AuditedRequest): string | null {
  if (!spec.resourceFrom) return null;
  const [source, field] = spec.resourceFrom.split('.') as ['params' | 'body', string];
  const value = request[source]?.[field];
  return typeof value === 'string' && value.length <= 64 ? value : null;
}

/** El registro de una llamada a una ruta `@Audited`. Nunca incluye el cuerpo (puede traer datos personales o fotos). */
export function auditEntryOf(
  spec: AuditedSpec,
  request: AuditedRequest,
  outcome: AuditOutcome,
  user: AuthenticatedUser | undefined = request.user,
  extra: Record<string, unknown> = {},
): AuditEntry {
  return {
    action: spec.action,
    outcome,
    actorId: user?.id ?? null,
    actorEmail: user?.email ?? null,
    actorRole: user?.role ?? null,
    resourceType: spec.resourceType ?? null,
    resourceId: resourceIdOf(spec, request),
    detail: { method: request.method, route: request.route?.path ?? null, params: request.params ?? {}, ...extra },
  };
}
