import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../../shared/domain/errors';
import { BUS_HISTORY, BusHistory, BusHistoryPort } from '../../domain/ports/bus-history.port';

/**
 * ESC-SEG-03: hoja de vida de un bus (conductores asignados, viajes, inspecciones con fotos, incidentes, reparaciones y
 * grúas), para saber quién hizo qué y si un daño ya estaba reportado antes de un cambio de turno.
 */
@Injectable()
export class GetBusHistoryUseCase {
  constructor(@Inject(BUS_HISTORY) private readonly history: BusHistoryPort) {}

  async execute(busId: string): Promise<BusHistory> {
    const history = await this.history.of(busId);
    if (!history) throw new NotFoundError(`Bus ${busId} no encontrado`);
    return history;
  }
}
