import { Logger } from '@nestjs/common';

const logger = new Logger('Concurrency');

/**
 * Log estructurado en JSON (una línea = un evento) para observabilidad.
 * Campos habituales: `trace_id`, `severity`, `waited_ms`, `held_ms`.
 */
export function logEvent(
  level: 'log' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown>,
) {
  logger[level](
    JSON.stringify({ ts: new Date().toISOString(), event, ...fields }),
  );
}
