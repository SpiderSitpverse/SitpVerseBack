import { Inject, Injectable } from '@nestjs/common';
import { UnauthorizedError } from '../../../shared/domain/errors';
import { AuthenticatedUser } from '../domain/models/authenticated-user';
import {
  LOGIN_ATTEMPT_LIMITER,
  LoginAttemptLimiterPort,
} from '../domain/ports/login-attempt-limiter.port';
import { PASSWORD_HASHER, PasswordHasherPort } from '../domain/ports/password-hasher.port';
import { TOKEN_SERVICE, IssuedToken, TokenServicePort } from '../domain/ports/token-service.port';
import { USER_DIRECTORY, UserDirectoryPort } from '../domain/ports/user-directory.port';

/**
 * Hash bcrypt de una contraseña cualquiera. Se compara cuando el empleado NO existe para
 * que responder "no existe" tarde lo mismo que responder "contraseña incorrecta": así nadie
 * puede descubrir qué números de empleado son válidos midiendo tiempos.
 */
const DUMMY_HASH = '$2b$10$BmtvptmGNSBBO7j0vmWRuOP1Y/I6WDTbRiwwvbQ8D3t.mQLVDp036';

export interface LoginResult extends IssuedToken {
  user: AuthenticatedUser;
}

/** HU-02: iniciar sesión con número de empleado y contraseña. */
@Injectable()
export class LoginUseCase {
  constructor(
    @Inject(USER_DIRECTORY) private readonly users: UserDirectoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenServicePort,
    @Inject(LOGIN_ATTEMPT_LIMITER) private readonly limiter: LoginAttemptLimiterPort,
  ) {}

  async execute(employeeId: string, password: string, ip = 'desconocida'): Promise<LoginResult> {
    const attempt = { employeeId, ip };
    // Primero el freno: un atacante bloqueado no llega siquiera a comparar contraseñas.
    await this.limiter.assertNotBlocked(attempt);

    const found = await this.users.findCredentialsByEmployeeId(employeeId);
    const valid = await this.hasher.matches(password, found?.passwordHash ?? DUMMY_HASH);

    // Mismo mensaje y mismo código para "no existe" y "contraseña incorrecta"; ambos cuentan como fallo
    // (si solo contaran las cuentas reales, el contador delataría qué números de empleado existen).
    if (!found || !valid) {
      await this.limiter.recordFailure(attempt);
      throw new UnauthorizedError('Credenciales inválidas');
    }
    await this.limiter.recordSuccess(attempt);

    const { user } = found;
    const token = this.tokens.issue({ sub: user.id, role: user.role, employeeId: user.employeeId });
    return { ...token, user };
  }
}
