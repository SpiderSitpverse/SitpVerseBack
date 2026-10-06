import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../../shared/domain/errors';
import {
  BUS_REPOSITORY,
  BusRepositoryPort,
} from '../../domain/ports/bus-repository.port';
import {
  BusActor,
  assertCanOperateBus,
  assertCanViewBus,
} from '../../domain/fleet.policy';

/**
 * Autoriza el acceso de un usuario a un bus concreto (autorización por RECURSO; la de
 * ROL ya la hizo el guard global). Lo usa el controller HTTP; el feed de posiciones
 * (sistema, no usuario) llama a los casos de uso directamente, sin pasar por aquí.
 */
@Injectable()
export class BusAccessService {
  constructor(@Inject(BUS_REPOSITORY) private readonly busRepository: BusRepositoryPort) {}

  async assertCanView(actor: BusActor, busId: string): Promise<void> {
    assertCanViewBus(actor, await this.load(busId));
  }

  async assertCanOperate(actor: BusActor, busId: string): Promise<void> {
    assertCanOperateBus(actor, await this.load(busId));
  }

  private async load(busId: string) {
    const bus = await this.busRepository.findById(busId);
    if (!bus) throw new NotFoundError(`Bus ${busId} no encontrado`);
    return bus;
  }
}
