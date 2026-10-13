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

/**
 * Eventos de "servicio terminado y puntos acreditados": los emiten completar una alerta y finalizar un informe.
 * Si con esa alerta el incidente quedó resuelto, se añade `incident.resolved` (el admin lo quita de su lista y se
 * descartan los avisos pendientes de ese incidente).
 */
export function callCompletedEvents(
  traceId: string,
  call: AssistanceCallModel,
  awardedUserIds: string[],
  incidentResolved: { id: string; busId: string } | null = null,
): AssistanceEvent[] {
  const events = [
    assistanceEvent(
      'call.completed',
      traceId,
      { roles: ['ADMIN'], userIds: awardedUserIds },
      {
        callId: call.id,
        incidentId: call.incidentId ?? null,
        kind: call.kind,
        busId: call.busId,
        rewardPoints: call.rewardPoints,
        awardedUserIds,
      },
    ),
  ];
  if (incidentResolved) {
    events.push(
      assistanceEvent('incident.resolved', traceId, { roles: ['ADMIN'] }, {
        incidentId: incidentResolved.id,
        busId: incidentResolved.busId,
      }),
    );
  }
  return events;
}
