import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JWTPayload, createRemoteJWKSet, jwtVerify } from 'jose';
import { UnauthorizedError } from '../../../../shared/domain/errors';
import { IdTokenVerifierPort, VerifiedIdentity } from '../../domain/ports/id-token-verifier.port';

const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
/** Google firma sus ID tokens con uno de estos dos emisores. */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
/** Tolerancia al desfase de relojes entre Google y este servidor. */
const CLOCK_TOLERANCE_SECONDS = 5;

const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/**
 * Verifica ID tokens de Google (OpenID Connect) con las llaves PÚBLICAS de Google: firma RS256, emisor (`iss`),
 * audiencia (`aud` = el Client ID de SitpVerse) y vencimiento (`exp`). Las llaves se descargan una vez y se cachean.
 *
 * `GOOGLE_JWKS_URI` solo se respeta fuera de producción: las pruebas de seguridad lo apuntan a un conjunto de llaves
 * falso y así prueban tokens alterados sin depender de Google (en producción la app no arranca si está definida).
 */
@Injectable()
export class GoogleIdTokenVerifier implements IdTokenVerifierPort {
  private readonly logger = new Logger(GoogleIdTokenVerifier.name);
  private readonly clientId: string;
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;

  constructor(config: ConfigService) {
    this.clientId = config.get<string>('GOOGLE_CLIENT_ID', '').trim();
    const production = config.get<string>('NODE_ENV') === 'production';
    const override = production ? undefined : config.get<string>('GOOGLE_JWKS_URI');
    this.keys = createRemoteJWKSet(new URL(override || GOOGLE_JWKS_URI), { timeoutDuration: 5000 });
    if (!this.clientId) {
      this.logger.warn('GOOGLE_CLIENT_ID no definido: el inicio de sesión con Google rechazará todos los tokens.');
    }
  }

  async verify(idToken: string): Promise<VerifiedIdentity> {
    if (!this.clientId) throw new UnauthorizedError('Inicio de sesión con Google no configurado');
    let payload: JWTPayload & Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(idToken, this.keys, {
        issuer: GOOGLE_ISSUERS,
        audience: this.clientId,
        algorithms: ['RS256'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      }));
    } catch (error) {
      throw new UnauthorizedError(`ID token rechazado: ${(error as { code?: string }).code ?? 'inválido'}`);
    }
    const email = text(payload.email);
    if (!payload.sub || !email) throw new UnauthorizedError('ID token sin sub o correo');
    return {
      subject: payload.sub,
      email,
      emailVerified: payload.email_verified === true || payload.email_verified === 'true',
      givenName: text(payload.given_name),
      familyName: text(payload.family_name),
      picture: text(payload.picture),
      nonce: text(payload.nonce),
    };
  }
}
