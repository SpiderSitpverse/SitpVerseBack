import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../domain/models/authenticated-user';
import { USER_DIRECTORY, UserDirectoryPort } from '../domain/ports/user-directory.port';

/**
 * Autentica a un empleado.
 *
 * Provisional: la "credencial" es solo el número de identificación (header `x-employee-id`
 * en HTTP, `auth.employeeId` en WebSocket). Cuando exista login real (HU-01/02), este caso
 * de uso valida un JWT y el resto del sistema no cambia: todos consumen `AuthenticatedUser`.
 */
@Injectable()
export class AuthenticateEmployeeUseCase {
  constructor(@Inject(USER_DIRECTORY) private readonly users: UserDirectoryPort) {}

  execute(employeeId: string | undefined): Promise<AuthenticatedUser | null> {
    if (!employeeId) return Promise.resolve(null);
    return this.users.findByEmployeeId(employeeId);
  }
}
