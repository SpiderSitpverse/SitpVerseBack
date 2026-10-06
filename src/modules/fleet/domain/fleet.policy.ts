import { ForbiddenError } from '../../../shared/domain/errors';
import { UserRole } from '../../../shared/domain/roles';
import { Bus } from './entities/bus.entity';

/** Quien actúa sobre un bus. Estructural: no depende del módulo `identity`. */
export interface BusActor {
  id: string;
  role: UserRole;
}

/**
 * Reglas de acceso a un bus (funciones puras, sin infraestructura):
 *  - ADMIN: ve y opera cualquier bus.
 *  - MECHANICAL: puede VER cualquier bus (necesita el detalle para repararlo), no operarlo.
 *  - DRIVER: ve y opera SOLO el bus que tiene asignado.
 */
export function canViewBus(actor: BusActor, bus: Bus): boolean {
  if (actor.role === 'ADMIN' || actor.role === 'MECHANICAL') return true;
  return actor.role === 'DRIVER' && bus.driverId === actor.id;
}

export function canOperateBus(actor: BusActor, bus: Bus): boolean {
  if (actor.role === 'ADMIN') return true;
  return actor.role === 'DRIVER' && bus.driverId === actor.id;
}

export function assertCanViewBus(actor: BusActor, bus: Bus): void {
  if (!canViewBus(actor, bus)) {
    throw new ForbiddenError(`No tienes acceso al bus ${bus.plate}`);
  }
}

export function assertCanOperateBus(actor: BusActor, bus: Bus): void {
  if (!canOperateBus(actor, bus)) {
    throw new ForbiddenError(`No puedes operar el bus ${bus.plate}`);
  }
}
