import { Inject, Injectable, Logger } from '@nestjs/common';
import { ForbiddenError, UnauthorizedError } from '../../../shared/domain/errors';
import { AuthenticatedUser } from '../domain/models/authenticated-user';
import {
  ACCESS_REQUEST_REPOSITORY,
  AccessRequestRepositoryPort,
} from '../domain/ports/access-request-repository.port';
import { AUDIT_LOG, AuditEntry, AuditLogPort } from '../domain/ports/audit-log.port';
import { AUTH_NONCE_STORE, AuthNonceStorePort } from '../domain/ports/auth-nonce.port';
import { ID_TOKEN_VERIFIER, IdTokenVerifierPort, VerifiedIdentity } from '../domain/ports/id-token-verifier.port';
import { LOGIN_RATE_LIMITER, LoginRateLimiterPort } from '../domain/ports/login-rate-limiter.port';
import { TOKEN_SERVICE, IssuedToken, TokenServicePort } from '../domain/ports/token-service.port';
import { USER_DIRECTORY, UserDirectoryPort } from '../domain/ports/user-directory.port';

export interface LoginResult extends IssuedToken {
  user: AuthenticatedUser;
}

const INVALID_TOKEN = 'Token de Google inválido';
/**
 * Respuesta para quien todavía no tiene acceso. La misma para "solicitud en espera", "cuenta desactivada" y "no se pudo
 * registrar la solicitud": quien lo intenta no puede averiguar si una cuenta existió o fue dada de baja.
 */
const PENDING_MESSAGE = 'Tu solicitud de acceso está en espera: un administrador debe aprobarla y asignarte un rol.';
const REJECTED_MESSAGE = 'Tu solicitud de acceso fue rechazada. Habla con un administrador.';
/** Solicitudes abiertas como máximo: nadie puede llenar la tabla pidiendo acceso con miles de cuentas. */
const MAX_OPEN_ACCESS_REQUESTS = 200;

/**
 * HU-02 · ESC-SEG-01: iniciar sesión con Google (OpenID Connect).
 *
 *  1. Límite por IP (429 + Retry-After).
 *  2. El ID token se verifica con las llaves públicas de Google (firma, emisor, audiencia, vencimiento): 401 si falla.
 *  3. El correo debe estar verificado y el `nonce` del token debe ser uno que entregó ESTE servidor y que no se haya
 *     usado antes: una respuesta robada o repetida no sirve.
 *  4. Se busca a la persona por `googleSub`; en su primer ingreso, por el correo con el que un administrador la
 *     prerregistró (y se guarda el `sub`).
 *  5. Si no tiene cuenta, queda una SOLICITUD DE ACCESO en espera (sin rol ni sesión) y recibe 403 con
 *     `reason: PENDING_APPROVAL`: un administrador la acepta y le da el rol desde "Usuarios".
 *  6. Con cuenta activa se emite el JWT de sesión (8 h). El rol sale de NUESTRA base, nunca de Google.
 *
 * Todo rechazo, toda solicitud y todo ingreso exitoso quedan en la auditoría.
 */
@Injectable()
export class GoogleLoginUseCase {
  private readonly logger = new Logger(GoogleLoginUseCase.name);

  constructor(
    @Inject(ID_TOKEN_VERIFIER) private readonly verifier: IdTokenVerifierPort,
    @Inject(AUTH_NONCE_STORE) private readonly nonces: AuthNonceStorePort,
    @Inject(LOGIN_RATE_LIMITER) private readonly limiter: LoginRateLimiterPort,
    @Inject(USER_DIRECTORY) private readonly users: UserDirectoryPort,
    @Inject(ACCESS_REQUEST_REPOSITORY) private readonly requests: AccessRequestRepositoryPort,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenServicePort,
    @Inject(AUDIT_LOG) private readonly audit: AuditLogPort,
  ) {}

  /** Entrega un nonce de un solo uso para que el front lo ponga en la petición a Google. */
  async issueNonce(ip = 'desconocida'): Promise<string> {
    await this.limiter.assertAllowed(ip);
    return this.nonces.issue();
  }

  async execute(idToken: string, nonce: string, ip = 'desconocida'): Promise<LoginResult> {
    await this.limiter.assertAllowed(ip);
    const identity = await this.verifiedIdentity(idToken, nonce, ip);
    const email = identity.email.trim().toLowerCase();

    const user =
      (await this.users.findByGoogleSubject(identity.subject)) ?? (await this.users.findUnlinkedByEmail(email));
    if (!user) return this.withoutAccount(identity, email, ip);

    const entry: AuditEntry = {
      action: 'auth.login',
      outcome: 'SUCCESS',
      actorId: user.id,
      actorEmail: email,
      actorSub: identity.subject,
      actorRole: user.role,
      resourceType: 'user',
      resourceId: user.id,
      ip,
    };
    let signedIn: AuthenticatedUser | null = null;
    try {
      signedIn = await this.users.recordGoogleLogin(
        user.id,
        {
          subject: identity.subject,
          firstName: identity.givenName,
          lastName: identity.familyName,
          photoUrl: identity.picture,
        },
        entry,
      );
    } catch (error) {
      // UNIQUE de googleSub: esa cuenta de Google ya está vinculada a otra persona.
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }
    if (!signedIn) {
      await this.reject(ip, 'ACCOUNT_NOT_ALLOWED', { sub: identity.subject, email });
      throw this.pending();
    }

    const token = this.tokens.issue({ sub: signedIn.id, role: signedIn.role, employeeId: signedIn.employeeId });
    return { ...token, user: signedIn };
  }

  /** Pasos 2 y 3: ID token válido, correo verificado y nonce de un solo uso. */
  private async verifiedIdentity(idToken: string, nonce: string, ip: string): Promise<VerifiedIdentity> {
    let identity: VerifiedIdentity;
    try {
      identity = await this.verifier.verify(idToken);
    } catch (error) {
      await this.reject(ip, 'INVALID_ID_TOKEN', { message: String((error as Error).message) });
      throw new UnauthorizedError(INVALID_TOKEN);
    }
    if (!identity.emailVerified) {
      await this.reject(ip, 'EMAIL_NOT_VERIFIED', { sub: identity.subject, email: identity.email });
      throw new UnauthorizedError(INVALID_TOKEN);
    }
    // El nonce del token debe coincidir con el de la petición Y haberlo entregado este servidor (y no usado antes).
    if (!identity.nonce || identity.nonce !== nonce || !(await this.nonces.consume(nonce))) {
      await this.reject(ip, 'INVALID_NONCE', { sub: identity.subject, email: identity.email });
      throw new UnauthorizedError(INVALID_TOKEN);
    }
    return identity;
  }

  /** Paso 5: la persona no tiene cuenta activa. Nunca recibe sesión. */
  private async withoutAccount(identity: VerifiedIdentity, email: string, ip: string): Promise<never> {
    const detail = { sub: identity.subject, email };
    if (await this.users.isDisabledAccount(identity.subject, email)) {
      await this.reject(ip, 'ACCOUNT_DISABLED', detail);
      throw this.pending(); // mismo mensaje que una solicitud en espera
    }

    const name = [identity.givenName, identity.familyName].filter(Boolean).join(' ') || email;
    const recorded = await this.requests.record(
      { subject: identity.subject, email, name, firstName: identity.givenName, lastName: identity.familyName, photoUrl: identity.picture },
      MAX_OPEN_ACCESS_REQUESTS,
      (request) => ({
        action: 'access.request',
        outcome: 'SUCCESS',
        actorEmail: email,
        actorSub: identity.subject,
        resourceType: 'access_request',
        resourceId: request.id,
        ip,
      }),
    );
    if (!recorded) {
      await this.reject(ip, 'ACCESS_REQUESTS_FULL', detail);
      throw this.pending();
    }
    if (recorded.request.status === 'REJECTED') {
      await this.reject(ip, 'ACCESS_REJECTED', detail);
      throw new ForbiddenError(REJECTED_MESSAGE, { reason: 'ACCESS_REJECTED' });
    }
    if (!recorded.created) await this.reject(ip, 'PENDING_APPROVAL', detail);
    throw this.pending();
  }

  private pending(): ForbiddenError {
    return new ForbiddenError(PENDING_MESSAGE, { reason: 'PENDING_APPROVAL' });
  }

  private async reject(ip: string, reason: string, detail: Record<string, unknown>): Promise<void> {
    this.logger.warn(JSON.stringify({ event: 'auth.login_rejected', severity: 'WARN', reason, ip }));
    try {
      await this.audit.record({
        action: 'auth.login',
        outcome: 'DENIED',
        actorEmail: typeof detail.email === 'string' ? detail.email : null,
        actorSub: typeof detail.sub === 'string' ? detail.sub : null,
        ip,
        detail: { reason, ...detail },
      });
    } catch (error) {
      // Un fallo al auditar no debe convertir un 403/401 en un 500, pero SÍ queda a la vista en el log.
      this.logger.error(JSON.stringify({ event: 'audit.write_failed', severity: 'ERROR', error: String(error) }));
    }
  }
}
