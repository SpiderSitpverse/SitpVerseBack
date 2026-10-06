import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { TooManyRequestsError, UnauthorizedError } from '../../../shared/domain/errors';
import { LoginUseCase } from '../application/login.use-case';
import { RedisLoginAttemptLimiter } from '../infrastructure/security/redis-login-attempt-limiter';
import { InMemoryUsers, fakeHasher } from './support/in-memory-users';

Logger.overrideLogger(false);

/** Redis simulado con los 4 comandos que usa el limitador y un reloj que se puede adelantar. */
class FakeRedis {
  now = 1_000_000;
  down = false;
  /** Redis "colgado": los comandos no responden nunca (como un servidor caído con la cola de reintentos). */
  hang = false;
  private data = new Map<string, { value: number; expiresAt: number | null }>();

  private live(key: string) {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }
  private check(): Promise<never> | void {
    if (this.down) throw new Error('Redis caído');
    if (this.hang) return new Promise<never>(() => undefined);
  }
  async get(key: string) {
    await this.check();
    return this.live(key)?.value.toString() ?? null;
  }
  async pttl(key: string) {
    await this.check();
    const entry = this.live(key);
    return entry ? (entry.expiresAt === null ? -1 : entry.expiresAt - this.now) : -2;
  }
  async del(key: string) {
    await this.check();
    this.data.delete(key);
  }
  /** Emula el script INCREMENT: suma 1 y fija el plazo SOLO en el primer incremento. */
  async eval(_script: string, _n: number, key: string, ttlMs: number) {
    await this.check();
    const entry = this.live(key);
    if (!entry) {
      this.data.set(key, { value: 1, expiresAt: this.now + Number(ttlMs) });
      return 1;
    }
    entry.value += 1;
    return entry.value;
  }
  advance(ms: number) {
    this.now += ms;
  }
}

function build(settings: Record<string, string> = {}) {
  const redis = new FakeRedis();
  const config = { get: (k: string, d?: unknown) => settings[k] ?? d } as unknown as ConfigService;
  const limiter = new RedisLoginAttemptLimiter(redis as unknown as Redis, config);

  const users = new InMemoryUsers();
  for (let i = 0; i < 40; i++) users.add(`E${i}`, `Empleado ${i}`, 'DRIVER', 'Clave2026');
  const tokens = { issue: () => ({ accessToken: 't', expiresIn: 1 }), verify: () => null };
  const login = new LoginUseCase(users, fakeHasher, tokens, limiter);
  return { redis, login };
}

const fail = (t: ReturnType<typeof build>, employeeId: string, ip: string) =>
  t.login.execute(employeeId, 'mala', ip).catch((e) => e);

describe('Freno a la fuerza bruta en el login', () => {
  it('tras 5 intentos fallidos, el 6.º se bloquea AUNQUE lleve la contraseña correcta (429)', async () => {
    const t = build();
    for (let i = 0; i < 5; i++) expect(await fail(t, 'E1', '10.0.0.1')).toBeInstanceOf(UnauthorizedError);

    const blocked = await t.login.execute('E1', 'Clave2026', '10.0.0.1').catch((e) => e);
    expect(blocked).toBeInstanceOf(TooManyRequestsError);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
  });

  it('antes del límite sigue funcionando normal: 4 fallos y luego la contraseña correcta entra', async () => {
    const t = build();
    for (let i = 0; i < 4; i++) await fail(t, 'E1', '10.0.0.1');
    await expect(t.login.execute('E1', 'Clave2026', '10.0.0.1')).resolves.toMatchObject({ user: { employeeId: 'E1' } });
  });

  it('un login correcto reinicia el contador de esa cuenta desde esa IP', async () => {
    const t = build();
    for (let i = 0; i < 4; i++) await fail(t, 'E1', '10.0.0.1');
    await t.login.execute('E1', 'Clave2026', '10.0.0.1');
    for (let i = 0; i < 4; i++) expect(await fail(t, 'E1', '10.0.0.1')).toBeInstanceOf(UnauthorizedError); // no se bloquea
  });

  it('el bloqueo de una cuenta desde una IP no afecta a la misma cuenta desde otra IP (el dueño legítimo puede entrar)', async () => {
    const t = build();
    for (let i = 0; i < 5; i++) await fail(t, 'E1', '10.0.0.1'); // el atacante
    await expect(t.login.execute('E1', 'Clave2026', '10.0.0.99')).resolves.toBeDefined(); // el empleado, otra IP
  });

  it('un empleado INEXISTENTE se frena igual que uno real (el contador no delata qué números existen)', async () => {
    const t = build();
    for (let i = 0; i < 5; i++) await fail(t, 'NO-EXISTE', '10.0.0.1');
    const blocked = await fail(t, 'NO-EXISTE', '10.0.0.1');
    const real = build();
    for (let i = 0; i < 5; i++) await fail(real, 'E1', '10.0.0.1');
    const realBlocked = await fail(real, 'E1', '10.0.0.1');

    expect(blocked).toBeInstanceOf(TooManyRequestsError);
    expect(realBlocked).toBeInstanceOf(TooManyRequestsError);
    expect(blocked.message).toBe(realBlocked.message);
  });

  it('una IP que prueba MUCHAS cuentas distintas se bloquea entera al llegar a su límite (barrido de usuarios)', async () => {
    const t = build({ LOGIN_IP_MAX_FAILURES: '30' });
    for (let i = 0; i < 30; i++) await fail(t, `E${i % 40}`, '10.0.0.1'); // 1 fallo por cuenta casi siempre
    const blocked = await t.login.execute('E39', 'Clave2026', '10.0.0.1').catch((e) => e);
    expect(blocked).toBeInstanceOf(TooManyRequestsError);
  });

  it('una cuenta atacada desde 20 IPs distintas se protege (ataque distribuido): ni siquiera una IP nueva logra probar', async () => {
    const t = build();
    for (let i = 0; i < 20; i++) await fail(t, 'E1', `10.1.0.${i}`);
    expect(await t.login.execute('E1', 'otra', '10.9.9.9').catch((e) => e)).toBeInstanceOf(TooManyRequestsError);
  });

  it('el bloqueo caduca solo pasados los 15 minutos', async () => {
    const t = build();
    for (let i = 0; i < 5; i++) await fail(t, 'E1', '10.0.0.1');
    expect(await fail(t, 'E1', '10.0.0.1')).toBeInstanceOf(TooManyRequestsError);

    t.redis.advance(14 * 60_000);
    expect(await fail(t, 'E1', '10.0.0.1')).toBeInstanceOf(TooManyRequestsError); // sigue bloqueado
    t.redis.advance(2 * 60_000);
    await expect(t.login.execute('E1', 'Clave2026', '10.0.0.1')).resolves.toBeDefined(); // ya pasó
  });

  it('por defecto el límite por IP es holgado (100): una clase entera detrás de la misma red no se bloquea por errores de tecleo', async () => {
    const t = build();
    for (let i = 0; i < 99; i++) await fail(t, `E${i % 40}`, '10.0.0.1'); // 99 fallos repartidos entre 40 cuentas
    await expect(t.login.execute('E39', 'Clave2026', '10.0.0.1')).resolves.toBeDefined();
  });

  it('los límites se configuran por variables de entorno', async () => {
    const t = build({ LOGIN_MAX_FAILURES: '2', LOGIN_LOCK_MINUTES: '1' });
    await fail(t, 'E1', '10.0.0.1');
    await fail(t, 'E1', '10.0.0.1');
    const blocked = await fail(t, 'E1', '10.0.0.1');
    expect(blocked).toBeInstanceOf(TooManyRequestsError);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('si Redis se cae NO se deja a todos los empleados fuera: el login sigue funcionando', async () => {
    const t = build();
    t.redis.down = true;
    await expect(t.login.execute('E1', 'Clave2026', '10.0.0.1')).resolves.toBeDefined();
    expect(await fail(t, 'E1', '10.0.0.1')).toBeInstanceOf(UnauthorizedError); // falla por credenciales, no por Redis
  });

  it('si Redis está COLGADO (no responde) el login no espera: cae en menos de ~2 s, no en 30 s', async () => {
    const t = build();
    t.redis.hang = true;
    const started = Date.now();
    await expect(t.login.execute('E1', 'Clave2026', '10.0.0.1')).resolves.toBeDefined();
    expect(Date.now() - started).toBeLessThan(2500);
  }, 10_000);
});
