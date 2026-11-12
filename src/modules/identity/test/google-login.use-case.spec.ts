import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ForbiddenError, TooManyRequestsError, UnauthorizedError } from '../../../shared/domain/errors';
import { GoogleLoginUseCase } from '../application/google-login.use-case';
import { IdTokenVerifierPort, VerifiedIdentity } from '../domain/ports/id-token-verifier.port';
import { LoginRateLimiterPort } from '../domain/ports/login-rate-limiter.port';
import { AuthNonceStorePort } from '../domain/ports/auth-nonce.port';
import { JwtTokenService } from '../infrastructure/security/jwt-token-service';
import { InMemoryAccessRequests } from './support/in-memory-access-requests';
import { InMemoryUsers } from './support/in-memory-users';

Logger.overrideLogger(false);

const tokens = new JwtTokenService({ get: (k: string, d?: string) => ({ JWT_SECRET: 'x'.repeat(40) })[k] ?? d } as unknown as ConfigService);

/** Verificador falso: el "ID token" es el nombre de una identidad registrada; cualquier otro texto es inválido. */
class FakeVerifier implements IdTokenVerifierPort {
  identities = new Map<string, VerifiedIdentity>();
  async verify(idToken: string) {
    const found = this.identities.get(idToken);
    if (!found) throw new UnauthorizedError('ID token rechazado');
    return found;
  }
}

class FakeNonces implements AuthNonceStorePort {
  valid = new Set<string>();
  private n = 0;
  async issue() {
    const nonce = `nonce-de-prueba-${++this.n}-xxxxxxxx`;
    this.valid.add(nonce);
    return nonce;
  }
  async consume(nonce: string) {
    return this.valid.delete(nonce);
  }
}

class FakeLimiter implements LoginRateLimiterPort {
  hits = new Map<string, number>();
  async assertAllowed(ip: string) {
    const n = (this.hits.get(ip) ?? 0) + 1;
    this.hits.set(ip, n);
    if (n > 10) throw new TooManyRequestsError('Demasiados intentos', 42);
  }
}

const identity = (over: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
  subject: 'google-sub-1',
  email: 'conductor@gmail.com',
  emailVerified: true,
  givenName: 'Carlos',
  familyName: 'Pérez',
  picture: 'https://lh3.googleusercontent.com/a/foto',
  nonce: null,
  ...over,
});

function build() {
  const users = new InMemoryUsers();
  const driver = users.add('2001', 'Prerregistrado', 'DRIVER', 'conductor@gmail.com');
  const verifier = new FakeVerifier();
  const nonces = new FakeNonces();
  const requests = new InMemoryAccessRequests(users);
  const useCase = new GoogleLoginUseCase(verifier, nonces, new FakeLimiter(), users, requests, tokens, users.audit);
  /** Un intento completo: pide nonce, "Google" firma un token con él y se envía. */
  const attempt = async (over: Partial<VerifiedIdentity> = {}, ip = '1.1.1.1', tokenName = `tok-${Math.random()}`) => {
    const nonce = await useCase.issueNonce(ip);
    verifier.identities.set(tokenName, identity({ nonce, ...over }));
    return { nonce, tokenName, run: () => useCase.execute(tokenName, nonce, ip) };
  };
  return { users, requests, driver, verifier, nonces, useCase, attempt };
}

describe('Inicio de sesión con Google (ESC-SEG-01)', () => {
  it('cuenta prerregistrada: en el primer ingreso se vincula por correo y se emite el JWT de sesión con el rol de NUESTRA base', async () => {
    const t = build();
    const result = await (await t.attempt()).run();

    expect(result.user).toMatchObject({ id: t.driver.id, role: 'DRIVER', email: 'conductor@gmail.com', name: 'Carlos Pérez' });
    expect(result.expiresIn).toBeGreaterThan(0);
    expect(tokens.verify(result.accessToken)).toMatchObject({ sub: t.driver.id, role: 'DRIVER' });
    expect(t.users.rows.get(t.driver.id)!.googleSub).toBe('google-sub-1');
    expect(t.users.audit.records).toContainEqual(
      expect.objectContaining({ action: 'auth.login', outcome: 'SUCCESS', actorId: t.driver.id, actorSub: 'google-sub-1', ip: '1.1.1.1' }),
    );
  });

  it('en el segundo ingreso entra por su googleSub aunque el correo ya no coincida', async () => {
    const t = build();
    await (await t.attempt()).run();
    const again = await (await t.attempt({ email: 'otro-correo@gmail.com' })).run();
    expect(again.user.id).toBe(t.driver.id);
  });

  it('el rol sale de la base: un admin que cambia a conductor entra como conductor', async () => {
    const t = build();
    t.users.rows.get(t.driver.id)!.role = 'MECHANICAL';
    expect((await (await t.attempt()).run()).user.role).toBe('MECHANICAL');
  });

  it('ID token inválido, alterado o de otra aplicación → 401 y queda auditado', async () => {
    const t = build();
    const nonce = await t.useCase.issueNonce('2.2.2.2');
    await expect(t.useCase.execute('token-alterado', nonce, '2.2.2.2')).rejects.toBeInstanceOf(UnauthorizedError);
    expect(t.users.audit.records).toContainEqual(
      expect.objectContaining({ action: 'auth.login', outcome: 'DENIED', ip: '2.2.2.2', detail: expect.objectContaining({ reason: 'INVALID_ID_TOKEN' }) }),
    );
  });

  it('correo sin verificar por Google → 401', async () => {
    const t = build();
    await expect((await t.attempt({ emailVerified: false })).run()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  describe('quien no tiene cuenta: solicitud de acceso en espera', () => {
    const stranger = { email: 'extraño@gmail.com', subject: 'otro-sub', givenName: 'Nuevo', familyName: 'Usuario' };

    it('queda una solicitud en espera, SIN rol ni sesión, y recibe 403 PENDING_APPROVAL', async () => {
      const t = build();
      const error = await (await t.attempt(stranger)).run().catch((e) => e);

      expect(error).toBeInstanceOf(ForbiddenError);
      expect(error.details).toEqual({ reason: 'PENDING_APPROVAL' });
      expect(await t.requests.list()).toEqual([
        expect.objectContaining({ email: 'extraño@gmail.com', name: 'Nuevo Usuario', status: 'PENDING' }),
      ]);
      expect(t.users.rows.size).toBe(1); // no se creó ningún usuario: solo existe el prerregistrado
      expect(t.users.audit.records).toContainEqual(
        expect.objectContaining({ action: 'access.request', outcome: 'SUCCESS', actorEmail: 'extraño@gmail.com' }),
      );
    });

    it('volver a intentarlo NO duplica la solicitud y queda auditado como DENIED', async () => {
      const t = build();
      await (await t.attempt(stranger)).run().catch(() => undefined);
      await (await t.attempt(stranger)).run().catch(() => undefined);
      expect(await t.requests.list()).toHaveLength(1);
      expect(t.users.audit.records).toContainEqual(
        expect.objectContaining({ outcome: 'DENIED', detail: expect.objectContaining({ reason: 'PENDING_APPROVAL' }) }),
      );
    });

    it('20 intentos simultáneos de la misma persona dejan UNA sola solicitud', async () => {
      const t = build();
      const attempts = await Promise.all(Array.from({ length: 20 }, (_, i) => t.attempt(stranger, `5.5.5.${i}`)));
      await Promise.allSettled(attempts.map((a) => a.run()));
      expect(await t.requests.list()).toHaveLength(1);
    });

    it('una solicitud RECHAZADA lo dice (403 ACCESS_REJECTED) y no entra', async () => {
      const t = build();
      await (await t.attempt(stranger)).run().catch(() => undefined);
      await t.requests.reject((await t.requests.list())[0].id, 'admin', { action: 'access.reject', outcome: 'SUCCESS' });
      const error = await (await t.attempt(stranger)).run().catch((e) => e);
      expect(error).toBeInstanceOf(ForbiddenError);
      expect(error.details).toEqual({ reason: 'ACCESS_REJECTED' });
    });

    it('con 200 solicitudes abiertas no se registran más (nadie llena la tabla) pero la respuesta es la misma', async () => {
      const t = build();
      for (let i = 0; i < 200; i++) {
        await t.requests.record({ subject: `s${i}`, email: `p${i}@gmail.com`, name: `P${i}`, firstName: null, lastName: null, photoUrl: null }, 200, () => ({ action: 'access.request', outcome: 'SUCCESS' }));
      }
      const error = await (await t.attempt(stranger)).run().catch((e) => e);
      expect(error.details).toEqual({ reason: 'PENDING_APPROVAL' });
      expect(await t.requests.list()).toHaveLength(200);
    });

    it('cuenta DESACTIVADA: mismo 403 que una solicitud en espera, y NO se crea solicitud (no revela quién fue empleado)', async () => {
      const t = build();
      t.users.rows.get(t.driver.id)!.active = false;
      const inactive = await (await t.attempt()).run().catch((e) => e);
      const unknown = await (await t.attempt(stranger)).run().catch((e) => e);
      expect(inactive).toBeInstanceOf(ForbiddenError);
      expect(inactive.message).toBe(unknown.message);
      expect(inactive.details).toEqual(unknown.details);
      expect((await t.requests.list()).map((r) => r.email)).toEqual(['extraño@gmail.com']); // solo la del desconocido
      expect(t.users.audit.records).toContainEqual(
        expect.objectContaining({ outcome: 'DENIED', detail: expect.objectContaining({ reason: 'ACCOUNT_DISABLED' }) }),
      );
    });

    it('la solicitud aceptada permite entrar con el rol asignado en el SIGUIENTE intento', async () => {
      const t = build();
      await (await t.attempt(stranger)).run().catch(() => undefined);
      const [request] = await t.requests.list();
      await t.requests.approve(request.id, { role: 'MECHANICAL' }, () => ({ action: 'access.approve', outcome: 'SUCCESS' }));
      const result = await (await t.attempt(stranger)).run();
      expect(result.user).toMatchObject({ role: 'MECHANICAL', email: 'extraño@gmail.com' });
      expect(tokens.verify(result.accessToken)).toMatchObject({ role: 'MECHANICAL' });
    });
  });

  it('una cuenta de Google ya vinculada entra SIEMPRE como su dueño, aunque presente el correo de otra persona', async () => {
    const t = build();
    const other = t.users.add('2002', 'Otra', 'DRIVER', 'otra@gmail.com');
    await (await t.attempt()).run(); // vincula google-sub-1 al conductor 2001
    const result = await (await t.attempt({ email: 'otra@gmail.com' })).run();
    expect(result.user.id).toBe(t.driver.id);
    expect(result.user.id).not.toBe(other.id);
  });

  it('si al vincular la base reporta el UNIQUE de googleSub (carrera entre dos cuentas) → 403 y queda auditado', async () => {
    const t = build();
    t.users.add('2002', 'Otra', 'DRIVER', 'otra@gmail.com');
    t.users.rows.get([...t.users.rows.values()].find((r) => r.employeeId === '2002')!.id)!.googleSub = 'google-sub-1';
    t.users.findByGoogleSubject = async () => null; // la lectura no la vio: simula la carrera
    await expect((await t.attempt()).run()).rejects.toBeInstanceOf(ForbiddenError);
    expect(t.users.audit.records.some((r) => r.outcome === 'DENIED')).toBe(true);
  });

  describe('nonce (contra reutilizar una respuesta de Google)', () => {
    it('el mismo ID token no sirve dos veces', async () => {
      const t = build();
      const a = await t.attempt();
      await a.run();
      await expect(a.run()).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('un token sin nonce, o con uno que este servidor no entregó, → 401', async () => {
      const t = build();
      const nonce = await t.useCase.issueNonce('3.3.3.3');
      t.verifier.identities.set('sin-nonce', identity({ nonce: null }));
      t.verifier.identities.set('ajeno', identity({ nonce: 'nonce-inventado-por-el-atacante' }));
      await expect(t.useCase.execute('sin-nonce', nonce, '3.3.3.3')).rejects.toBeInstanceOf(UnauthorizedError);
      await expect(t.useCase.execute('ajeno', 'nonce-inventado-por-el-atacante', '3.3.3.3')).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('el nonce de la petición debe coincidir con el del token', async () => {
      const t = build();
      const a = await t.attempt();
      const other = await t.useCase.issueNonce('1.1.1.1');
      await expect(t.useCase.execute(a.tokenName, other, '1.1.1.1')).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('20 intentos simultáneos con el mismo nonce: solo uno entra', async () => {
      const t = build();
      const a = await t.attempt();
      const results = await Promise.allSettled(Array.from({ length: 20 }, () => a.run()));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });
  });

  it('más de 10 intentos por minuto desde una IP → 429 con Retry-After', async () => {
    const t = build();
    for (let i = 0; i < 10; i++) await t.useCase.issueNonce('9.9.9.9');
    await expect(t.useCase.execute('x'.repeat(30), 'n'.repeat(20), '9.9.9.9')).rejects.toMatchObject({ retryAfterSeconds: 42 });
    await expect(t.useCase.issueNonce('9.9.9.9')).rejects.toBeInstanceOf(TooManyRequestsError);
    await expect(t.useCase.issueNonce('9.9.9.10')).resolves.toEqual(expect.any(String)); // otra IP no se ve afectada
  });

  it('si la auditoría de un rechazo falla, el cliente igual recibe 401 (no un 500)', async () => {
    const t = build();
    const nonce = await t.useCase.issueNonce('4.4.4.4');
    t.users.audit.failNextWrite = true;
    await expect(t.useCase.execute('token-malo', nonce, '4.4.4.4')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('dos primeros ingresos simultáneos de la misma cuenta: ambos entran y queda UN solo sub vinculado', async () => {
    const t = build();
    const [a, b] = await Promise.all([t.attempt(), t.attempt()]);
    const results = await Promise.allSettled([a.run(), b.run()]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(t.users.rows.get(t.driver.id)!.googleSub).toBe('google-sub-1');
  });
});
