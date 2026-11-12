export const REQUEST_LOG = Symbol('REQUEST_LOG');

export interface RequestLogView {
  id: string;
  at: Date;
  traceId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  ip: string | null;
  country: string | null;
  userAgent: string | null;
  userId: string | null;
  role: string | null;
}

export interface RequestLogQuery {
  userId?: string;
  ip?: string;
  country?: string;
  status?: number;
  /** Ruta que empieza por este texto (p. ej. `/fleet`). */
  path?: string;
  from?: Date;
  to?: Date;
  /** Paginación: solo registros anteriores a esta marca de tiempo. */
  before?: Date;
  limit: number;
}

/** Puerto de CONSULTA del registro de peticiones (solo lectura: no existe ninguna operación para modificarlo o borrarlo). */
export interface RequestLogPort {
  list(query: RequestLogQuery): Promise<RequestLogView[]>;
}
