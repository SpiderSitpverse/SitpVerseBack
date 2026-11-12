import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { RequestSinkPort } from '../domain/request-sink.port';
import { logEvent } from '../infrastructure/structured-log';
import { cleanUserAgent, countryOf, normalizeIp, runWithRequestContext } from './client-info';

/** Valor que un cliente puede mandar en `X-Trace-Id` para seguir su petición de punta a punta (si es razonable). */
const SAFE_TRACE_ID = /^[A-Za-z0-9._-]{8,64}$/;
/** Las comprobaciones de salud de Azure (una por minuto por instancia) y las fotos no aportan: se omiten. */
const SKIPPED_PATHS = /^\/(health|uploads\/)/;

export type RequestLogFields = {
  event: 'http.request';
  trace_id: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  ip: string | null;
  country: string | null;
  user_agent: string | null;
  user_id: string | null;
  role: string | null;
  severity: 'INFO' | 'WARN' | 'ERROR';
};

/** Gravedad según el código: 5xx es un error nuestro; 4xx lo causó quien llamó. */
export function severityOf(status: number): RequestLogFields['severity'] {
  if (status >= 500) return 'ERROR';
  if (status >= 400) return 'WARN';
  return 'INFO';
}

const LEVEL_OF = { ERROR: 'error', WARN: 'warn', INFO: 'log' } as const;

/**
 * Registro de TODAS las peticiones HTTP (ESC-SEG-03 y ESC-OBS-01): hora, IP, país, navegador, usuario, ruta, código y
 * duración. Cada una sale como una línea JSON (visible en los logs de Azure) y se entrega al `sink` para guardarla en la
 * base, y todo el trabajo de la petición corre dentro de su contexto (IP, país, navegador y `trace_id`): la auditoría lo lee
 * de ahí. El `trace_id` también se devuelve en el header `X-Trace-Id`.
 *
 * Quedan registradas también las rechazadas (401, 403, 429) y las de quien no inició sesión.
 *
 * Seguridad: se registra la RUTA sin la query (podría traer datos) y NUNCA cabeceras (salvo el navegador) ni cuerpos: el token
 * de sesión viaja en `Authorization` y el ID token de Google en el cuerpo del login.
 */
export function requestLogger(sink?: RequestSinkPort, now: () => number = Date.now) {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header('x-trace-id');
    const traceId = incoming && SAFE_TRACE_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Trace-Id', traceId);
    (req as Request & { traceId?: string }).traceId = traceId;

    const ip = normalizeIp(req.ip);
    const country = countryOf(ip);
    const userAgent = cleanUserAgent(req.header('user-agent'));
    const startedAt = now();

    res.on('finish', () => {
      const path = req.originalUrl.split('?')[0];
      if (SKIPPED_PATHS.test(path)) return;
      const user = (req as Request & { user?: { id: string; role: string } }).user;
      const fields: RequestLogFields = {
        event: 'http.request',
        trace_id: traceId,
        method: req.method,
        path,
        status: res.statusCode,
        duration_ms: now() - startedAt,
        ip,
        country,
        user_agent: userAgent,
        user_id: user?.id ?? null,
        role: user?.role ?? null,
        severity: severityOf(res.statusCode),
      };
      logEvent(LEVEL_OF[fields.severity], fields.event, fields);
      sink?.push({
        at: new Date(startedAt),
        traceId,
        method: fields.method,
        path,
        status: fields.status,
        durationMs: fields.duration_ms,
        ip,
        country,
        userAgent,
        userId: fields.user_id,
        role: fields.role,
      });
    });

    runWithRequestContext({ traceId, ip, country, userAgent }, next);
  };
}
