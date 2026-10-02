import { randomUUID } from 'crypto';
import { RealtimeAudience } from '../../../shared/contracts/realtime.contract';
import { AssistanceEvent, AssistanceEventType } from '../domain/events/assistance-events';

/**
 * Construye un evento con su `eventId` único (idempotencia en el cliente), sello de tiempo
 * y trace_id, para no repetirlo en cada caso de uso.
 */
export function assistanceEvent(
  type: AssistanceEventType,
  traceId: string,
  audience: RealtimeAudience,
  payload: Record<string, unknown>,
): AssistanceEvent {
  return {
    eventId: randomUUID(),
    type,
    traceId,
    occurredAt: new Date().toISOString(),
    audience,
    payload,
  };
}
