export const REQUEST_SINK = Symbol('REQUEST_SINK');

/** Una petición HTTP ya atendida: lo mínimo que exige ESC-SEG-03 (hora, IP, usuario, navegador, país) más el resultado. */
export interface RequestRecord {
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

/** Puerto: a dónde van los registros de peticiones (hoy una tabla de solo inserción en PostgreSQL). */
export interface RequestSinkPort {
  /** No bloquea la petición: el adaptador guarda por lotes. */
  push(record: RequestRecord): void;
}
