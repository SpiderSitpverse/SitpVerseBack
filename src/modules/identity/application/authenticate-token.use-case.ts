import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../domain/models/authenticated-user';
import { TOKEN_SERVICE, TokenServicePort } from '../domain/ports/token-service.port';
import { USER_DIRECTORY, UserDirectoryPort } from '../domain/ports/user-directory.port';

/**
 * Convierte un token de acceso en el usuario autenticado (lo usan el guard HTTP y el
 * gateway de WebSocket). Devuelve null si el token es inválido, está vencido o su usuario
 * ya no existe: el usuario se vuelve a leer de la BD en cada uso, así que dar de baja a un
 * empleado le quita el acceso aunque su token no haya vencido, y un cambio de rol aplica de inmediato.
 */
@Injectable()
export class AuthenticateTokenUseCase {
  constructor(
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenServicePort,
    @Inject(USER_DIRECTORY) private readonly users: UserDirectoryPort,
  ) {}

  async execute(token: string | undefined): Promise<AuthenticatedUser | null> {
    if (!token) return null;
    const claims = this.tokens.verify(token);
    if (!claims) return null;
    return this.users.findById(claims.sub);
  }
}
