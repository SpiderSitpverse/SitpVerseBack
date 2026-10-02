import { Inject, Injectable } from '@nestjs/common';
import {
  ASSISTANCE_REPOSITORY,
  AssistanceRepositoryPort,
} from '../../domain/ports/assistance-repository.port';

/** Incidentes reportados por conductores (vista de administración). */
@Injectable()
export class ListIncidentsUseCase {
  constructor(
    @Inject(ASSISTANCE_REPOSITORY) private readonly repo: AssistanceRepositoryPort,
  ) {}

  execute() {
    return this.repo.listIncidents();
  }
}
