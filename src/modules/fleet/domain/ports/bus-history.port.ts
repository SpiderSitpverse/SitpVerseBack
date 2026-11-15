export const BUS_HISTORY = Symbol('BUS_HISTORY');

/**
 * Hoja de vida de un bus (ESC-SEG-03): todo lo que le ha pasado, para resolver disputas ("¿este daño ya estaba
 * reportado antes del cambio de turno?"). Cada lista viene de la más reciente a la más antigua.
 */
export interface BusHistory {
  bus: { id: string; plate: string; route: string; status: string; driverId: string | null; driverName: string | null };
  /** Acciones auditadas sobre el bus: conductores asignados, viajes iniciados y finalizados, cambios de ficha... */
  events: {
    at: string;
    action: string;
    outcome: string;
    actorId: string | null;
    actorEmail: string | null;
    actorRole: string | null;
    detail: Record<string, unknown> | null;
  }[];
  inspections: {
    id: string;
    at: string;
    inspectorId: string;
    inspectorName: string;
    inspectorRole: string;
    note: string;
    comment: string | null;
    photos: string[];
  }[];
  incidents: {
    id: string;
    at: string;
    type: string;
    description: string | null;
    status: string;
    reportedById: string;
    reportedByName: string | null;
    evidence: { url: string; caption: string | null; uploadedById: string; at: string }[];
  }[];
  repairs: {
    callId: string;
    at: string;
    status: string;
    description: string | null;
    completedAt: string | null;
    mechanicName: string | null;
    damages: string | null;
    replacedParts: string | null;
    busPhotos: string[];
    partPhotos: string[];
  }[];
  tows: {
    id: string;
    at: string;
    incidentId: string;
    towTruck: string;
    crew: string;
    status: string;
    assignedById: string;
    completedAt: string | null;
  }[];
}

export interface BusHistoryPort {
  /** null si el bus no existe. Se arma con UNA sola consulta a la base. */
  of(busId: string): Promise<BusHistory | null>;
}
