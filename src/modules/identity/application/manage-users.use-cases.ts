import { Inject, Injectable } from '@nestjs/common';
import { DISTRIBUTED_LOCK, DistributedLockPort } from '../../../shared/domain/distributed-lock.port';
import { ConflictError, NotFoundError, UnauthorizedError } from '../../../shared/domain/errors';
import { UserRole } from '../../../shared/domain/roles';
import { PASSWORD_HASHER, PasswordHasherPort } from '../domain/ports/password-hasher.port';
import {
  USER_ADMIN_REPOSITORY,
  UserAdminRepositoryPort,
  UserView,
} from '../domain/ports/user-admin-repository.port';
import { USER_DIRECTORY, UserDirectoryPort } from '../domain/ports/user-directory.port';
import {
  assertCanChangeAccess,
  assertStrongEnoughPassword,
  assertValidEmployeeId,
} from '../domain/user.policy';

/** HU-04: el administrador ve a todo el personal registrado. */
@Injectable()
export class ListUsersUseCase {
  constructor(@Inject(USER_ADMIN_REPOSITORY) private readonly users: UserAdminRepositoryPort) {}

  execute(): Promise<UserView[]> {
    return this.users.list();
  }
}

/** HU-04: crear la cuenta de un empleado nuevo (número de empleado + nombre + rol + contraseña inicial). */
@Injectable()
export class CreateUserUseCase {
  constructor(
    @Inject(USER_ADMIN_REPOSITORY) private readonly users: UserAdminRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
  ) {}

  async execute(data: {
    employeeId: string;
    name: string;
    role: UserRole;
    password: string;
  }): Promise<UserView> {
    assertValidEmployeeId(data.employeeId);
    assertStrongEnoughPassword(data.password);

    const passwordHash = await this.hasher.hash(data.password);
    try {
      return await this.users.create({
        employeeId: data.employeeId,
        name: data.name.trim(),
        role: data.role,
        passwordHash,
      });
    } catch (error) {
      // Violación del UNIQUE de employeeId (la decide la base de datos, así dos altas simultáneas no pasan las dos)
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictError('Ese número de empleado ya está en uso', { reason: 'EMPLOYEE_ID_TAKEN' });
      }
      throw error;
    }
  }
}

/** Una sola fila de espera para todo cambio que pueda quitar acceso de administrador. */
const ADMIN_ACCESS_LOCK = 'lock:identity:admin-access';

/** HU-05 y HU-06: editar nombre y rol, o desactivar y reactivar una cuenta (sin perder su historial). */
@Injectable()
export class UpdateUserUseCase {
  constructor(
    @Inject(USER_ADMIN_REPOSITORY) private readonly users: UserAdminRepositoryPort,
    @Inject(DISTRIBUTED_LOCK) private readonly lock: DistributedLockPort,
  ) {}

  async execute(
    actorId: string,
    userId: string,
    change: { name?: string; role?: UserRole; active?: boolean },
  ): Promise<UserView> {
    // "Contar administradores y luego cambiar" es check-then-act: dos admins que se desactivan entre
    // sí a la vez leerían ambos "hay 2" y dejarían el sistema sin ninguno. Se serializa con el lock.
    const { value } = await this.lock.withLock(ADMIN_ACCESS_LOCK, async () => {
      const target = await this.users.findUserView(userId);
      if (!target) throw new NotFoundError(`Usuario ${userId} no encontrado`);

      assertCanChangeAccess(actorId, target, change, await this.users.countActiveAdmins());
      return this.users.update(userId, { ...change, name: change.name?.trim() });
    });
    return value;
  }
}

/** El administrador asigna una contraseña nueva a un empleado (p. ej. si la olvidó). */
@Injectable()
export class ResetPasswordUseCase {
  constructor(
    @Inject(USER_ADMIN_REPOSITORY) private readonly users: UserAdminRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
  ) {}

  async execute(userId: string, newPassword: string): Promise<void> {
    if (!(await this.users.findUserView(userId))) throw new NotFoundError(`Usuario ${userId} no encontrado`);
    assertStrongEnoughPassword(newPassword);
    await this.users.setPasswordHash(userId, await this.hasher.hash(newPassword));
  }
}

/** Cualquier usuario cambia SU contraseña, comprobando antes la actual. */
@Injectable()
export class ChangeOwnPasswordUseCase {
  constructor(
    @Inject(USER_DIRECTORY) private readonly directory: UserDirectoryPort,
    @Inject(USER_ADMIN_REPOSITORY) private readonly users: UserAdminRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
  ) {}

  async execute(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const currentHash = await this.directory.findPasswordHash(userId);
    if (!currentHash || !(await this.hasher.matches(currentPassword, currentHash))) {
      throw new UnauthorizedError('La contraseña actual es incorrecta');
    }
    assertStrongEnoughPassword(newPassword);
    if (await this.hasher.matches(newPassword, currentHash)) {
      throw new ConflictError('La contraseña nueva debe ser distinta de la actual', { reason: 'SAME_PASSWORD' });
    }
    await this.users.setPasswordHash(userId, await this.hasher.hash(newPassword));
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
