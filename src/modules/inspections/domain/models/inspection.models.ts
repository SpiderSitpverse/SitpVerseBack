import { UserRole } from '../../../../shared/domain/roles';

/** Inspección previa al viaje. Inmutable: una vez registrada no se edita ni se borra. */
export interface InspectionModel {
  id: string;
  busId: string;
  inspectorId: string;
  /** Nombre y rol de quien inspeccionó, copiados al registrar (la hoja de vida no cambia aunque cambie el usuario). */
  inspectorName: string;
  inspectorRole: UserRole;
  note: string;
  comment: string | null;
  /** URLs de las fotos (`/uploads/<id>.jpg`). */
  photos: string[];
  createdAt: Date;
}

export interface NewInspection {
  busId: string;
  inspectorId: string;
  inspectorName: string;
  inspectorRole: UserRole;
  note: string;
  comment?: string;
  photos: string[];
}

export interface InspectionFilter {
  busId?: string;
  /** Nombre (parcial) de quien inspeccionó. */
  inspector?: string;
  from?: Date;
  to?: Date;
  take: number;
  skip: number;
}
