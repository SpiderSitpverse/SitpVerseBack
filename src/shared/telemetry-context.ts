import { randomUUID } from 'crypto';
import { currentRequestContext, runWithRequestContext } from './http/client-info';

/**
 * El `trace_id` de la petición en curso. Hay UN solo contexto (el que abre `requestLogger`, con la IP, el país y el
 * navegador), así que el trace_id de los logs, de la auditoría, de `request_log`, de los eventos y de las métricas es
 * siempre el mismo y coincide con el header `X-Trace-Id` de la respuesta.
 */
export function runWithTrace<T>(traceId: string, callback: () => T): T {
  const current = currentRequestContext();
  return runWithRequestContext(
    { ip: null, country: null, userAgent: null, ...current, traceId },
    callback,
  );
}

export function currentTraceId(): string | undefined {
  return currentRequestContext()?.traceId;
}

export function currentTraceIdOrNew(): string {
  return currentTraceId() ?? randomUUID();
}
