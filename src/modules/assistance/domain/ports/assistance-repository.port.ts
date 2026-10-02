import { AssistanceEvent, EventsOf } from '../events/assistance-events';
import {
  AssistanceCallModel,
  AssistanceKind,
  CallStatus,
  CancelResult,
  ClaimModel,
  ClaimResult,
  ClaimWithUser,
  CompleteResult,
  DriverIncidentModel,
} from '../models/assistance.models';

export const ASSISTANCE_REPOSITORY = Symbol('ASSISTANCE_REPOSITORY');

export interface NewCall {
  kind: AssistanceKind;
  busId: string;
  slots: number;
  rewardPoints: number;
  createdById: string;
  description?: string;
}

/**
 * Puerto de persistencia de asistencia.
 *
 * Garantías de cada operación de ESCRITURA:
 *  - **Atómica (compare-and-set)**: decide y cambia el estado en un solo paso; la
 *    concurrencia nunca deja más reclamos que cupos ni premia dos veces.
 *  - **Con outbox**: los eventos (`eventsOf`) se guardan en la MISMA transacción que el
 *    cambio de estado. O se confirman los dos o ninguno: un evento nunca se pierde ni se
 *    emite por un cambio que hizo rollback.
 */
export interface AssistanceRepositoryPort {
  createIncident(
    data: { busId: string; reportedById: string; type: string; description?: string },
    eventsOf: EventsOf<DriverIncidentModel>,
  ): Promise<DriverIncidentModel>;
  findIncident(id: string): Promise<DriverIncidentModel | null>;
  listIncidents(): Promise<DriverIncidentModel[]>;

  /**
   * Incidente REPORTED→HELP_REQUESTED + crea la alerta, en una transacción.
   * Devuelve null si otro admin ya había lanzado la alerta de ese incidente.
   */
  createSupportCallForIncident(
    incidentId: string,
    data: NewCall,
    eventsOf: EventsOf<AssistanceCallModel>,
  ): Promise<AssistanceCallModel | null>;

  /**
   * Crea una alerta. Para REPAIR deduplica por bus: si ya hay una reparación abierta devuelve
   * la existente con `created = false` y NO emite eventos.
   */
  createCall(
    data: NewCall,
    eventsOf: EventsOf<AssistanceCallModel>,
  ): Promise<{ call: AssistanceCallModel; created: boolean }>;

  findCall(id: string): Promise<AssistanceCallModel | null>;
  listCalls(filter?: { kind?: AssistanceKind; status?: CallStatus }): Promise<AssistanceCallModel[]>;
  /** Aceptaciones de varias alertas, con el nombre de quien aceptó. */
  listClaims(callIds: string[]): Promise<ClaimWithUser[]>;

  /** Toma un cupo de forma atómica (todo-o-nada). Quien llega después de llenarse recibe `FULL`. */
  tryClaim(
    callId: string,
    userId: string,
    data: { busId: string | null; arriveBy: Date },
    eventsOf: EventsOf<{ call: AssistanceCallModel; claim: ClaimModel; filled: boolean }>,
  ): Promise<ClaimResult>;

  /** Cancela una aceptación activa: libera el cupo (la alerta vuelve a OPEN si estaba llena). */
  cancelClaim(
    callId: string,
    claimId: string,
    cancelledById: string,
    eventsOf: EventsOf<{ call: AssistanceCallModel; claim: ClaimModel }>,
  ): Promise<CancelResult>;

  /**
   * Cierra la alerta UNA sola vez y acredita los puntos (libro `reward_entries`, único por
   * usuario+alerta) a quienes tienen una aceptación ACTIVA. Devuelve null si ya estaba completada.
   */
  complete(callId: string, eventsOf: EventsOf<CompleteResult>): Promise<CompleteResult | null>;

  /** Eventos sin cambio de estado (p. ej. reenviar una alerta), también durables. */
  enqueueEvents(events: AssistanceEvent[]): Promise<void>;

  /** Saldo de puntos de un usuario (suma del libro). */
  getPoints(userId: string): Promise<number>;
}
