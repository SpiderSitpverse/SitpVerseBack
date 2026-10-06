import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtPayload, decode, sign, verify } from 'jsonwebtoken';
import { USER_ROLES } from '../../../../shared/domain/roles';
import {
  IssuedToken,
  TokenClaims,
  TokenServicePort,
} from '../../domain/ports/token-service.port';

const DEV_SECRET = 'dev-only-secret-no-usar-en-produccion';
const MIN_PRODUCTION_SECRET_LENGTH = 32;
const ALGORITHM = 'HS256';

/**
 * Tokens JWT firmados con HS256.
 *
 * `JWT_SECRET` es OBLIGATORIO en producción (mínimo 32 caracteres): si falta, la app no
 * arranca. En desarrollo se usa un secreto fijo y se avisa en el log.
 */
@Injectable()
export class JwtTokenService implements TokenServicePort {
  private readonly logger = new Logger(JwtTokenService.name);
  private readonly secret: string;
  private readonly expiresIn: string;

  constructor(config: ConfigService) {
    const configured = config.get<string>('JWT_SECRET');
    const production = config.get<string>('NODE_ENV') === 'production';

    if (production && (!configured || configured.length < MIN_PRODUCTION_SECRET_LENGTH)) {
      throw new Error(
        `JWT_SECRET es obligatorio en producción (mínimo ${MIN_PRODUCTION_SECRET_LENGTH} caracteres)`,
      );
    }
    if (!configured) {
      this.logger.warn('JWT_SECRET no definido: usando un secreto de DESARROLLO. No lo uses en producción.');
    }
    this.secret = configured ?? DEV_SECRET;
    this.expiresIn = config.get<string>('JWT_EXPIRES_IN', '8h');
  }

  issue(claims: TokenClaims): IssuedToken {
    const accessToken = sign(claims, this.secret, { algorithm: ALGORITHM, expiresIn: this.expiresIn } as never);
    const { exp, iat } = decode(accessToken) as JwtPayload;
    return { accessToken, expiresIn: (exp as number) - (iat as number) };
  }

  verify(token: string): TokenClaims | null {
    try {
      // Se fija el algoritmo: así no se acepta un token con `alg: none` ni con otro algoritmo.
      const payload = verify(token, this.secret, { algorithms: [ALGORITHM] }) as JwtPayload;
      const role = payload.role as TokenClaims['role'];
      if (!payload.sub || !USER_ROLES.includes(role)) return null;
      return { sub: payload.sub, role, employeeId: String(payload.employeeId) };
    } catch {
      return null; // firma inválida, vencido o malformado
    }
  }
}
