import { Inject, Injectable } from '@nestjs/common';
import { AUDIT_LOG, AuditLogPort, AuditQuery, AuditRecord } from '../domain/ports/audit-log.port';
import { REQUEST_LOG, RequestLogPort, RequestLogQuery, RequestLogView } from '../domain/ports/request-log.port';

const DEFAULT_LIMIT = 50;

/** ESC-SEG-03: consultar el registro de auditoría (solo lectura). */
@Injectable()
export class ListAuditUseCase {
  constructor(@Inject(AUDIT_LOG) private readonly audit: AuditLogPort) {}

  execute(query: Partial<AuditQuery>): Promise<AuditRecord[]> {
    return this.audit.list({ ...query, limit: query.limit ?? DEFAULT_LIMIT });
  }
}

/** ESC-SEG-03: consultar el registro de TODAS las peticiones (hora, IP, país, navegador, usuario). Solo lectura. */
@Injectable()
export class ListRequestLogUseCase {
  constructor(@Inject(REQUEST_LOG) private readonly requests: RequestLogPort) {}

  execute(query: Partial<RequestLogQuery>): Promise<RequestLogView[]> {
    return this.requests.list({ ...query, limit: query.limit ?? DEFAULT_LIMIT });
  }
}
