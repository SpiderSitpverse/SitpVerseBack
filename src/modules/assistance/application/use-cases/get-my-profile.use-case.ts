import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../../../identity/public';
import {
  ASSISTANCE_REPOSITORY,
  AssistanceRepositoryPort,
} from '../../domain/ports/assistance-repository.port';

/** Perfil del usuario con su saldo de puntos (suma del libro de recompensas). */
@Injectable()
export class GetMyProfileUseCase {
  constructor(
    @Inject(ASSISTANCE_REPOSITORY) private readonly repo: AssistanceRepositoryPort,
  ) {}

  async execute(actor: AuthenticatedUser) {
    return { ...actor, points: await this.repo.getPoints(actor.id) };
  }
}
