import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { currentRequestContext } from '../../../../shared/http/client-info';
import { PrismaService } from '../../../../shared/infrastructure/prisma.service';
import { AuditEntry, AuditLogPort, AuditQuery, AuditRecord } from '../../domain/ports/audit-log.port';

/** Fila de `audit_log` a partir de una entrada. Compartido con los adaptadores que auditan dentro de su transacción. */
export function auditData(entry: AuditEntry): Prisma.AuditLogUncheckedCreateInput {
  // IP, país, navegador y trace_id salen de la petición en curso: ninguna acción crítica puede quedar sin ellos.
  const request = currentRequestContext();
  return {
    action: entry.action,
    outcome: entry.outcome,
    actorId: entry.actorId ?? null,
    actorEmail: entry.actorEmail ?? null,
    actorSub: entry.actorSub ?? null,
    actorRole: entry.actorRole ?? null,
    resourceType: entry.resourceType ?? null,
    resourceId: entry.resourceId ?? null,
    ip: entry.ip ?? request?.ip ?? null,
    userAgent: entry.userAgent ?? request?.userAgent ?? null,
    country: entry.country ?? request?.country ?? null,
    traceId: entry.traceId ?? request?.traceId ?? null,
    detail: (entry.detail ?? undefined) as Prisma.InputJsonValue | undefined,
  };
}

/** Auditoría sobre PostgreSQL. Solo inserta y consulta: la tabla rechaza UPDATE y DELETE con un trigger. */
@Injectable()
export class PrismaAuditLog implements AuditLogPort {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.prisma.auditLog.create({ data: auditData(entry) });
  }

  async list(query: AuditQuery): Promise<AuditRecord[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        action: query.action,
        actorId: query.actorId,
        resourceType: query.resourceType,
        resourceId: query.resourceId,
        outcome: query.outcome,
        at: { gte: query.from, lte: query.to, lt: query.before },
      },
      orderBy: { at: 'desc' },
      take: query.limit,
    });
    return rows.map((row) => ({
      ...row,
      outcome: row.outcome as AuditRecord['outcome'],
      detail: (row.detail as Record<string, unknown> | null) ?? null,
    }));
  }
}
