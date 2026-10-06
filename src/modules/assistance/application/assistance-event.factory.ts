import { randomUUID } from 'crypto';
import { RealtimeAudience } from '../../../shared/contracts/realtime.contract';
import { AssistanceEvent, AssistanceEventType } from '../domain/events/assistance-events';
import { AssistanceCallModel } from '../domain/models/assistance.models';

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

/** Evento "servicio terminado y puntos acreditados": lo emiten completar una alerta y finalizar un informe. */
export function callCompletedEvents(
  traceId: string,
  call: AssistanceCallModel,
  awardedUserIds: string[],
): AssistanceEvent[] {
  return [
    assistanceEvent(
      'call.completed',
      traceId,
      { roles: ['ADMIN'], userIds: awardedUserIds },
      {
        callId: call.id,
        kind: call.kind,
        busId: call.busId,
        rewardPoints: call.rewardPoints,
        awardedUserIds,
      },
    ),
  ];
}
