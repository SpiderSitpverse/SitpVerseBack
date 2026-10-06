import { UserRole } from '../../../../shared/domain/roles';

export const TOKEN_SERVICE = Symbol('TOKEN_SERVICE');

/** Lo que se firma dentro del token. Lo mínimo: el usuario se vuelve a leer de la BD en cada petición. */
export interface TokenClaims {
  /** id del usuario */
  sub: string;
  role: UserRole;
  employeeId: string;
}

export interface IssuedToken {
  accessToken: string;
  /** Segundos de vida (para que el front sepa cuándo pedir login de nuevo). */
  expiresIn: number;
}

/** Puerto: emisión y verificación de tokens de acceso (hoy JWT). */
export interface TokenServicePort {
  issue(claims: TokenClaims): IssuedToken;
  /** Devuelve las claims si el token es válido y no venció; null en cualquier otro caso. */
  verify(token: string): TokenClaims | null;
}
