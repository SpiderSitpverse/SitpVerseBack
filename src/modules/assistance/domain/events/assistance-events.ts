import { AudienceEvent } from '../../../../shared/contracts/realtime.contract';

export type AssistanceEventType =
  | 'incident.reported' // conductor → administración
  | 'incident.deleted' // el admin eliminó un incidente (y sus alertas sin atender): refrescar listas
  | 'call.opened' // alerta nueva (o reenviada) para conductores o mecánicos
  | 'call.progress' // cambió el número de aceptaciones (para administración)
  | 'call.closed' // cupos completos: se deshabilita la notificación
  | 'claim.cancelled' // el admin canceló una aceptación (no llegó a tiempo): libera el cupo
  | 'call.completed' // servicio terminado y puntos acreditados
  // --- bloqueos, rutas alternativas, grúas y evidencia (RoutingService) ---
  | 'blockage.reported' // un conductor reportó un bloqueo → ADMIN
  | 'blockage.alerted' // el admin avisó del bloqueo a la flota → DRIVER
  | 'incident.evidence.attached' // se adjuntó una foto a un incidente
  | 'tow.assigned' // se asignó grúa y cuadrilla a un incidente
  | 'tow.completed' // terminó el servicio de grúa: grúa y cuadrilla quedan libres
  | 'route.proposed' // el admin dibujó una ruta alternativa
  | 'route.assigned' // el admin asignó la ruta a un conductor
  | 'route.accepted'; // el conductor aceptó la ruta asignada

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
