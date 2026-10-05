export const BUS_DIRECTORY = Symbol('BUS_DIRECTORY');

export interface BusRef {
  id: string;
  plate: string;
}

/**
 * Puerto (anticorruption layer): lo que `assistance` necesita saber de la flota.
 * No lee las tablas de otro módulo; el adapter lo resuelve a través de la API pública de
 * `fleet`. Si mañana la flota vive en otro servicio, solo cambia el adapter.
 */
export interface BusDirectoryPort {
  exists(busId: string): Promise<boolean>;
  /** El bus asignado a un conductor (null si no tiene). */
  findBusOfDriver(userId: string): Promise<BusRef | null>;
}
