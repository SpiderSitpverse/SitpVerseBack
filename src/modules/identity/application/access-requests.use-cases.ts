import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, InvalidInputError, NotFoundError } from '../../../shared/domain/errors';
import { UserRole } from '../../../shared/domain/roles';
import {
  ACCESS_REQUEST_REPOSITORY,
  AccessRequestRepositoryPort,
  AccessRequestView,
} from '../domain/ports/access-request-repository.port';
import { UserView } from '../domain/ports/user-admin-repository.port';
import { assertValidEmployeeId } from '../domain/user.policy';
import { Actor } from './manage-users.use-cases';

/** Dos aceptaciones simultáneas del mismo rol pueden elegir el mismo número libre: se reintenta con el siguiente. */
const MAX_EMPLOYEE_ID_ATTEMPTS = 5;

function uniqueTarget(error: unknown): string | null {
  if ((error as { code?: string }).code !== 'P2002') return null;
  const meta = (error as { meta?: { target?: string | string[] } }).meta?.target;
  return Array.isArray(meta) ? meta.join(',') : (meta ?? '');
}

/** El administrador ve quién pidió acceso y está esperando (o fue rechazado). */
@Injectable()
export class ListAccessRequestsUseCase {
  constructor(@Inject(ACCESS_REQUEST_REPOSITORY) private readonly requests: AccessRequestRepositoryPort) {}

  execute(): Promise<AccessRequestView[]> {
    return this.requests.list();
  }
}

/**
 * El administrador ACEPTA una solicitud y le da un rol: se crea el usuario (con su cuenta de Google ya vinculada) y desde
 * su siguiente ingreso entra con ese rol. Sin número de empleado, se asigna el siguiente libre del rol.
 */
@Injectable()
export class ApproveAccessRequestUseCase {
  constructor(@Inject(ACCESS_REQUEST_REPOSITORY) private readonly requests: AccessRequestRepositoryPort) {}

  async execute(
    actor: Actor,
    requestId: string,
    data: { role: UserRole; employeeId?: string; name?: string },
    ip?: string,
  ): Promise<UserView> {
    if (data.employeeId) assertValidEmployeeId(data.employeeId);
    const audit = (user: UserView) => ({
      action: 'access.approve',
      outcome: 'SUCCESS' as const,
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: 'ADMIN' as const,
      resourceType: 'user',
      resourceId: user.id,
      ip,
      detail: { requestId, role: user.role, employeeId: user.employeeId, email: user.email },
    });

    for (let attempt = 1; attempt <= MAX_EMPLOYEE_ID_ATTEMPTS; attempt++) {
      try {
        const user = await this.requests.approve(requestId, data, audit);
        if (!user) throw new NotFoundError('La solicitud ya no existe (otro administrador la decidió)');
        return user;
      } catch (error) {
        const target = uniqueTarget(error);
        if (target === null) throw error;
        if (target.includes('email') || target.includes('googleSub')) {
          throw new ConflictError('Esa persona ya tiene una cuenta', { reason: 'EMAIL_TAKEN' });
        }
        if (data.employeeId) {
          throw new ConflictError('Ese número de empleado ya está en uso', { reason: 'EMPLOYEE_ID_TAKEN' });
        }
        // número automático ocupado por otra aceptación simultánea: se reintenta con el siguiente libre
      }
    }
    throw new ConflictError('No se pudo asignar un número de empleado; inténtalo de nuevo', { reason: 'EMPLOYEE_ID_TAKEN' });
  }
}

/** El administrador RECHAZA una solicitud: la persona sigue sin acceso y se le avisa al volver a intentarlo. */
@Injectable()
export class RejectAccessRequestUseCase {
  constructor(@Inject(ACCESS_REQUEST_REPOSITORY) private readonly requests: AccessRequestRepositoryPort) {}

  async execute(actor: Actor, requestId: string, ip?: string): Promise<void> {
    const request = await this.requests.findById(requestId);
    if (!request) throw new NotFoundError('La solicitud ya no existe');
    if (request.status === 'REJECTED') throw new InvalidInputError('La solicitud ya estaba rechazada');
    const done = await this.requests.reject(requestId, actor.id, {
      action: 'access.reject',
      outcome: 'SUCCESS',
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: 'ADMIN',
      resourceType: 'access_request',
      resourceId: requestId,
      ip,
      detail: { email: request.email },
    });
    if (!done) throw new NotFoundError('La solicitud ya no existe');
  }
}
