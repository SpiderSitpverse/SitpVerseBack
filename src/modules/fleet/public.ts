/**
 * API PÚBLICA del módulo fleet: lo único que otros módulos pueden importar de aquí.
 * (Un test de arquitectura lo hace cumplir.)
 */
export { FleetModule } from './fleet.module';
export { FleetQueryService } from './application/services/fleet-query.service';
export type { BusSummary } from './application/services/fleet-query.service';
export type { BusPositionEvent } from './domain/ports/position-publisher.port';
