import { AudienceEvent } from '../../../../shared/contracts/realtime.contract';

export type AssistanceEventType =
  | 'incident.reported' // conductor → administración
  | 'call.opened' // alerta nueva (o reenviada) para conductores o mecánicos
  | 'call.progress' // cambió el número de aceptaciones (para administración)
  | 'call.closed' // cupos completos: se deshabilita la notificación
  | 'claim.cancelled' // el admin canceló una aceptación (no llegó a tiempo): libera el cupo
  | 'call.completed'; // servicio terminado y puntos acreditados

export interface AssistanceEvent extends AudienceEvent {
  type: AssistanceEventType;
  traceId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

/**
 * Los eventos NO se publican directamente: el caso de uso le entrega al repositorio una
 * función que los construye a partir del resultado, y el repositorio los guarda en el
 * outbox DENTRO de la misma transacción que el cambio de estado (ver README: Outbox).
 * El caso de uso sigue sin saber que existen Redis ni WebSocket.
 */
export type EventsOf<Result> = (result: Result) => AssistanceEvent[];
