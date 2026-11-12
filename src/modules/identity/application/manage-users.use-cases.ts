import { Inject, Injectable } from '@nestjs/common';
import { DISTRIBUTED_LOCK, DistributedLockPort } from '../../../shared/domain/distributed-lock.port';
import { ConflictError, NotFoundError } from '../../../shared/domain/errors';
import { UserRole } from '../../../shared/domain/roles';
import {
  USER_ADMIN_REPOSITORY,
  UserAdminRepositoryPort,
  UserChange,
  UserView,
} from '../domain/ports/user-admin-repository.port';
import { assertCanChangeAccess, assertValidEmail, assertValidEmployeeId, normalizeEmail } from '../domain/user.policy';

/** Quién hace el cambio (para la auditoría). */
export interface Actor {
  id: string;
  email: string;
}

/** Violación de un UNIQUE: la decide la base de datos, así dos altas simultáneas no pasan las dos. */
function toConflict(error: unknown): never {
  if ((error as { code?: string }).code !== 'P2002') throw error;
  const meta = (error as { meta?: { target?: string | string[] } }).meta?.target;
  const target = Array.isArray(meta) ? meta.join(',') : (meta ?? '');
  if (target.includes('email')) {
    throw new ConflictError('Ese correo ya está registrado', { reason: 'EMAIL_TAKEN' });
  }
  throw new ConflictError('Ese número de empleado ya está en uso', { reason: 'EMPLOYEE_ID_TAKEN' });
}

/** HU-04: el administrador ve a todo el personal registrado. */
@Injectable()
export class ListUsersUseCase {
  constructor(@Inject(USER_ADMIN_REPOSITORY) private readonly users: UserAdminRepositoryPort) {}

  execute(): Promise<UserView[]> {
    return this.users.list();
  }
}

/**
 * HU-04: prerregistrar a un empleado (número de empleado + nombre + rol + correo de Google). No lleva contraseña:
 * la persona entra con su cuenta de Google y, en su primer ingreso, queda vinculada por ese correo.
 */
@Injectable()
export class CreateUserUseCase {
  constructor(@Inject(USER_ADMIN_REPOSITORY) private readonly users: UserAdminRepositoryPort) {}

  async execute(
    actor: Actor,
    data: { employeeId: string; name: string; role: UserRole; email: string },
    ip?: string,
  ): Promise<UserView> {
    assertValidEmployeeId(data.employeeId);
    assertValidEmail(data.email);
    try {
      return await this.users.create(
        { employeeId: data.employeeId, name: data.name.trim(), role: data.role, email: normalizeEmail(data.email) },
        (created) => ({
          action: 'user.create',
          outcome: 'SUCCESS',
          actorId: actor.id,
          actorEmail: actor.email,
          actorRole: 'ADMIN',
          resourceType: 'user',
          resourceId: created.id,
          ip,
          detail: { employeeId: created.employeeId, role: created.role, email: created.email },
        }),
      );
    } catch (error) {
      return toConflict(error);
    }
  }
}

/** Una sola fila de espera para todo cambio que pueda quitar acceso de administrador. */
const ADMIN_ACCESS_LOCK = 'lock:identity:admin-access';

/** HU-05 y HU-06: editar nombre, rol o correo, o desactivar y reactivar una cuenta (sin perder su historial). */
@Injectable()
export class UpdateUserUseCase {
  constructor(
    @Inject(USER_ADMIN_REPOSITORY) private readonly users: UserAdminRepositoryPort,
    @Inject(DISTRIBUTED_LOCK) private readonly lock: DistributedLockPort,
  ) {}

  async execute(actor: Actor, userId: string, change: UserChange, ip?: string): Promise<UserView> {
    if (change.email !== undefined) assertValidEmail(change.email);
    // "Contar administradores y luego cambiar" es check-then-act: dos admins que se desactivan entre
    // sí a la vez leerían ambos "hay 2" y dejarían el sistema sin ninguno. Se serializa con el lock.
    const { value } = await this.lock.withLock(ADMIN_ACCESS_LOCK, async () => {
      const target = await this.users.findUserView(userId);
      if (!target) throw new NotFoundError(`Usuario ${userId} no encontrado`);

      assertCanChangeAccess(actor.id, target, change, await this.users.countActiveAdmins());
      const data: UserChange = {
        ...change,
        name: change.name?.trim(),
        email: change.email === undefined ? undefined : normalizeEmail(change.email),
      };
      try {
        return await this.users.update(userId, data, (updated) => ({
          action: change.role !== undefined && change.role !== target.role ? 'user.role_change' : 'user.update',
          outcome: 'SUCCESS',
          actorId: actor.id,
          actorEmail: actor.email,
          actorRole: 'ADMIN',
          resourceType: 'user',
          resourceId: updated.id,
          ip,
          detail: {
            before: { name: target.name, role: target.role, email: target.email, active: target.active },
            after: { name: updated.name, role: updated.role, email: updated.email, active: updated.active },
          },
        }));
      } catch (error) {
        return toConflict(error);
      }
    });
    return value;
  }
}

/** Consulta pública (para otros módulos, p. ej. flota al asignar un conductor): ¿existe y qué rol tiene? */
@Injectable()
export class FindActiveUserUseCase {
  constructor(@Inject(USER_ADMIN_REPOSITORY) private readonly users: UserAdminRepositoryPort) {}

  async execute(userId: string): Promise<{ id: string; name: string; role: UserRole } | null> {
    const user = await this.users.findUserView(userId);
    return user?.active ? { id: user.id, name: user.name, role: user.role } : null;
  }
}
