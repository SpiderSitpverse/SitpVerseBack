import { InspectionFilter, InspectionModel, NewInspection } from '../models/inspection.models';

export const INSPECTION_REPOSITORY = Symbol('INSPECTION_REPOSITORY');

/** Puerto de persistencia. Solo se puede AGREGAR y consultar: las inspecciones no se modifican. */
export interface InspectionRepositoryPort {
  create(data: NewInspection): Promise<InspectionModel>;
  /** La inspección más reciente de un bus (null si nunca se inspeccionó). */
  findLatestByBus(busId: string): Promise<InspectionModel | null>;
  /** Historial, de la más reciente a la más antigua. */
  list(filter: InspectionFilter): Promise<InspectionModel[]>;
}
