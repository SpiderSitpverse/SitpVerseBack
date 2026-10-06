import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import { UnauthorizedError } from '../../../shared/domain/errors';
import { AuthenticateTokenUseCase } from '../application/authenticate-token.use-case';
import { LoginUseCase } from '../application/login.use-case';
import { AuthenticatedUser } from '../domain/models/authenticated-user';
import { PasswordHasherPort } from '../domain/ports/password-hasher.port';
import { UserDirectoryPort, UserWithCredentials } from '../domain/ports/user-directory.port';
import { BcryptPasswordHasher } from '../infrastructure/security/bcrypt-password-hasher';
import { JwtTokenService } from '../infrastructure/security/jwt-token-service';
import { hashSync } from 'bcryptjs';

Logger.overrideLogger(false);

const config = (values: Record<string, string> = {}) =>
  ({ get: (key: string, fallback?: string) => values[key] ?? fallback }) as unknown as ConfigService;

const driver: AuthenticatedUser = { id: 'u-2001', employeeId: '2001', name: 'Carlos', role: 'DRIVER' };

function build() {
  const storedHash = hashSync('Sitp2026!', 4); // costo bajo: solo para que los tests sean rápidos
  const directory: UserDirectoryPort & { removed: Set<string> } = {
    removed: new Set(),
    async findById(id) {
      return id === driver.id && !this.removed.has(id) ? driver : null;
    },
    async findCredentialsByEmployeeId(employeeId): Promise<UserWithCredentials | null> {
      return employeeId === driver.employeeId ? { user: driver, passwordHash: storedHash } : null;
    },
    async findPasswordHash() {
      return storedHash;
    },
  };
  const realHasher = new BcryptPasswordHasher();
  const hasherCalls: string[] = [];
  const hasher: PasswordHasherPort = {
    hash: (plain) => realHasher.hash(plain),
    matches: (plain, hash) => {
      hasherCalls.push(hash);
      return realHasher.matches(plain, hash);
    },
  };
  const tokens = new JwtTokenService(config({ JWT_SECRET: 'secreto-de-prueba-de-al-menos-32-caracteres!' }));
  return {
    directory,
    hasherCalls,
    storedHash,
    tokens,
    login: new LoginUseCase(directory, hasher, tokens),
    authenticate: new AuthenticateTokenUseCase(tokens, directory),
  };
}

describe('Login (HU-02)', () => {
  it('con credenciales válidas devuelve un token y el usuario SIN el hash de la contraseña', async () => {
    const t = build();
    const result = await t.login.execute('2001', 'Sitp2026!');

    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.expiresIn).toBe(8 * 3600);
    expect(result.user).toEqual(driver);
    expect(JSON.stringify(result)).not.toContain(t.storedHash);
    expect(JSON.stringify(result)).not.toContain('passwordHash');
  });

  it('contraseña incorrecta → 401 con mensaje genérico', async () => {
    const t = build();
    await expect(t.login.execute('2001', 'otra-clave')).rejects.toThrow(UnauthorizedError);
    await expect(t.login.execute('2001', 'otra-clave')).rejects.toThrow('Credenciales inválidas');
  });

  it('empleado inexistente → MISMA respuesta que contraseña incorrecta (no revela qué números existen)', async () => {
    const t = build();
    const wrongPassword = await t.login.execute('2001', 'x').catch((e) => e);
    const unknownUser = await t.login.execute('9999', 'x').catch((e) => e);
    expect(unknownUser).toBeInstanceOf(UnauthorizedError);
    expect(unknownUser.message).toBe(wrongPassword.message);
    expect(unknownUser.code).toBe(wrongPassword.code);
  });

  it('con un empleado inexistente igual se hace una comparación bcrypt (el tiempo no delata nada)', async () => {
    const t = build();
    await t.login.execute('9999', 'x').catch(() => undefined);
    expect(t.hasherCalls).toHaveLength(1);
    expect(t.hasherCalls[0]).toMatch(/^\$2[aby]\$\d\d\$.{53}$/); // un hash bcrypt válido, no una cadena vacía
  });

  it('el token firmado identifica al usuario', async () => {
    const t = build();
    const { accessToken } = await t.login.execute('2001', 'Sitp2026!');
    await expect(t.authenticate.execute(accessToken)).resolves.toEqual(driver);
  });

  it('un empleado dado de baja pierde el acceso aunque su token no haya vencido', async () => {
    const t = build();
    const { accessToken } = await t.login.execute('2001', 'Sitp2026!');
    t.directory.removed.add(driver.id);
    await expect(t.authenticate.execute(accessToken)).resolves.toBeNull();
  });

  it.each([undefined, '', 'no-es-un-jwt'])('token %p → no autentica', async (token) => {
    await expect(build().authenticate.execute(token)).resolves.toBeNull();
  });
});

describe('JwtTokenService', () => {
  const secret = 'secreto-de-prueba-de-al-menos-32-caracteres!';
  const service = new JwtTokenService(config({ JWT_SECRET: secret }));
  const claims = { sub: 'u1', role: 'ADMIN' as const, employeeId: '1001' };

  it('emite y verifica un token', () => {
    expect(service.verify(service.issue(claims).accessToken)).toEqual(claims);
  });

  it('rechaza un token firmado con otro secreto', () => {
    const forged = sign(claims, 'otro-secreto-distinto-de-treinta-y-dos-chars!!', { algorithm: 'HS256' });
    expect(service.verify(forged)).toBeNull();
  });

  it('rechaza un token manipulado (se cambia el rol sin poder re-firmar)', () => {
    const [header, , signature] = service.issue(claims).accessToken.split('.');
    const body = Buffer.from(JSON.stringify({ ...claims, role: 'DRIVER' })).toString('base64url');
    expect(service.verify(`${header}.${body}.${signature}`)).toBeNull();
  });

  it('rechaza un token sin firma (alg: none)', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    expect(service.verify(`${header}.${body}.`)).toBeNull();
  });

  it('rechaza un token vencido', async () => {
    const short = new JwtTokenService(config({ JWT_SECRET: secret, JWT_EXPIRES_IN: '1ms' }));
    const { accessToken } = short.issue(claims);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(short.verify(accessToken)).toBeNull();
  });

  it('rechaza un rol que no existe aunque la firma sea válida', () => {
    const token = sign({ ...claims, role: 'SUPERUSER' }, secret, { algorithm: 'HS256' });
    expect(service.verify(token)).toBeNull();
  });

  it('en producción NO arranca sin JWT_SECRET, ni con uno corto', () => {
    expect(() => new JwtTokenService(config({ NODE_ENV: 'production' }))).toThrow(/JWT_SECRET/);
    expect(() => new JwtTokenService(config({ NODE_ENV: 'production', JWT_SECRET: 'corto' }))).toThrow(/JWT_SECRET/);
    expect(() => new JwtTokenService(config({ NODE_ENV: 'production', JWT_SECRET: secret }))).not.toThrow();
  });
});
