import {
  ConflictError,
  InvalidInputError,
  NotFoundError,
  UnauthorizedError,
} from '../../../shared/domain/errors';
import {
  ChangeOwnPasswordUseCase,
  CreateUserUseCase,
  FindActiveUserUseCase,
  ResetPasswordUseCase,
  UpdateUserUseCase,
} from '../application/manage-users.use-cases';
import { AuthenticateTokenUseCase } from '../application/authenticate-token.use-case';
import { JwtTokenService } from '../infrastructure/security/jwt-token-service';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { InMemoryLock } from '../../../shared/testing/in-memory-lock';
import { InMemoryUsers, fakeHasher } from './support/in-memory-users';

Logger.overrideLogger(false);

function build() {
  const users = new InMemoryUsers();
  const admin = users.add('1001', 'Admin Uno', 'ADMIN');
  const admin2 = users.add('1002', 'Admin Dos', 'ADMIN');
  const driver = users.add('2001', 'Conductor', 'DRIVER', 'Clave2026');
  return {
    users,
    admin,
    admin2,
    driver,
    create: new CreateUserUseCase(users, fakeHasher),
    update: new UpdateUserUseCase(users, new InMemoryLock()),
    reset: new ResetPasswordUseCase(users, fakeHasher),
    change: new ChangeOwnPasswordUseCase(users, users, fakeHasher),
    find: new FindActiveUserUseCase(users),
  };
}

describe('Crear usuarios (HU-04)', () => {
  it('crea la cuenta con la contraseña cifrada y sin exponerla', async () => {
    const t = build();
    const created = await t.create.execute({ employeeId: '3001', name: '  Mecánico  ', role: 'MECHANICAL', password: 'Taller2026' });

    expect(created).toMatchObject({ employeeId: '3001', name: 'Mecánico', role: 'MECHANICAL', active: true });
    expect(JSON.stringify(created)).not.toMatch(/Taller2026|hash:|passwordHash/);
    expect((await t.users.findCredentialsByEmployeeId('3001'))!.passwordHash).toBe('hash:Taller2026');
  });

  it('rechaza un número de empleado repetido con 409 (lo decide la base de datos)', async () => {
    const t = build();
    await expect(
      t.create.execute({ employeeId: '2001', name: 'Otro', role: 'DRIVER', password: 'Clave2026' }),
    ).rejects.toMatchObject({ details: { reason: 'EMPLOYEE_ID_TAKEN' } });
  });

  it('dos altas simultáneas del mismo número: solo una se crea', async () => {
    const t = build();
    const results = await Promise.allSettled(
      [1, 2].map(() => t.create.execute({ employeeId: '4001', name: 'X', role: 'DRIVER', password: 'Clave2026' })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')[0]).toMatchObject({ reason: expect.any(ConflictError) });
  });

  it.each([
    ['corta', 'Ab1'],
    ['sin números', 'SoloLetrasAqui'],
    ['sin letras', '1234567890'],
  ])('rechaza una contraseña débil (%s) con 400', async (_n, password) => {
    const t = build();
    await expect(
      t.create.execute({ employeeId: '5001', name: 'X', role: 'DRIVER', password }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it.each(['ab', 'con espacios', 'raro/id', 'x'.repeat(40)])('rechaza el número de empleado %p', async (employeeId) => {
    const t = build();
    await expect(
      t.create.execute({ employeeId, name: 'X', role: 'DRIVER', password: 'Clave2026' }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe('Editar y desactivar (HU-05 / HU-06)', () => {
  it('cambia el rol de un usuario (conductor → mecánico)', async () => {
    const t = build();
    const updated = await t.update.execute(t.admin.id, t.driver.id, { role: 'MECHANICAL' });
    expect(updated.role).toBe('MECHANICAL');
  });

  it('un usuario desactivado no puede autenticarse ni con su token anterior', async () => {
    const t = build();
    const tokens = new JwtTokenService({ get: (k: string, d?: string) => ({ JWT_SECRET: 'x'.repeat(40) })[k] ?? d } as unknown as ConfigService);
    const { accessToken } = tokens.issue({ sub: t.driver.id, role: 'DRIVER', employeeId: '2001' });
    const authenticate = new AuthenticateTokenUseCase(tokens, t.users);

    await expect(authenticate.execute(accessToken)).resolves.toMatchObject({ id: t.driver.id });
    await t.update.execute(t.admin.id, t.driver.id, { active: false });

    await expect(authenticate.execute(accessToken)).resolves.toBeNull();
    await expect(t.users.findCredentialsByEmployeeId('2001')).resolves.toBeNull(); // tampoco puede iniciar sesión
    await expect(t.find.execute(t.driver.id)).resolves.toBeNull();
  });

  it('al reactivar la cuenta recupera el acceso con su misma contraseña', async () => {
    const t = build();
    await t.update.execute(t.admin.id, t.driver.id, { active: false });
    await t.update.execute(t.admin.id, t.driver.id, { active: true });
    await expect(t.users.findCredentialsByEmployeeId('2001')).resolves.toMatchObject({ passwordHash: 'hash:Clave2026' });
  });

  it('un admin no puede desactivarse ni quitarse el rol a sí mismo', async () => {
    const t = build();
    await expect(t.update.execute(t.admin.id, t.admin.id, { active: false })).rejects.toMatchObject({
      details: { reason: 'SELF_LOCKOUT' },
    });
    await expect(t.update.execute(t.admin.id, t.admin.id, { role: 'DRIVER' })).rejects.toBeInstanceOf(ConflictError);
  });

  it('nunca puede quedar el sistema sin un administrador activo', async () => {
    const t = build();
    await t.update.execute(t.admin.id, t.admin2.id, { active: false }); // queda 1 admin activo
    await expect(t.update.execute(t.admin2.id, t.admin.id, { active: false })).rejects.toMatchObject({
      details: expect.objectContaining({ reason: expect.stringMatching(/LAST_ADMIN|SELF_LOCKOUT/) }),
    });
    expect(await t.users.countActiveAdmins()).toBe(1);
  });

  it('dos admins se desactivan entre sí AL MISMO TIEMPO → solo uno lo logra (nunca quedan 0 administradores)', async () => {
    const t = build();
    const results = await Promise.allSettled([
      t.update.execute(t.admin.id, t.admin2.id, { active: false }),
      t.update.execute(t.admin2.id, t.admin.id, { active: false }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')[0]).toMatchObject({ reason: expect.any(ConflictError) });
    expect(await t.users.countActiveAdmins()).toBe(1);
  });

  it('10 administradores se desactivan a la vez: siempre queda al menos uno', async () => {
    const t = build();
    const admins = [t.admin, t.admin2, ...Array.from({ length: 8 }, (_, i) => t.users.add(`19${i}`, `Admin ${i}`, 'ADMIN'))];
    await Promise.allSettled(
      admins.map((a, i) => t.update.execute(a.id, admins[(i + 1) % admins.length].id, { active: false })),
    );
    expect(await t.users.countActiveAdmins()).toBeGreaterThanOrEqual(1);
  });

  it('editar un usuario que no existe → 404', async () => {
    const t = build();
    await expect(
      t.update.execute(t.admin.id, '00000000-0000-4000-8000-000000000000', { name: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('Contraseñas', () => {
  it('el admin restablece la contraseña de otro empleado', async () => {
    const t = build();
    await t.reset.execute(t.driver.id, 'NuevaClave99');
    expect((await t.users.findCredentialsByEmployeeId('2001'))!.passwordHash).toBe('hash:NuevaClave99');
  });

  it('restablecer valida la fortaleza y que el usuario exista', async () => {
    const t = build();
    await expect(t.reset.execute(t.driver.id, 'corta1')).rejects.toBeInstanceOf(InvalidInputError);
    await expect(t.reset.execute('00000000-0000-4000-8000-000000000000', 'NuevaClave99')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('cada usuario cambia SU contraseña con la actual', async () => {
    const t = build();
    await t.change.execute(t.driver.id, 'Clave2026', 'Distinta2027');
    expect((await t.users.findCredentialsByEmployeeId('2001'))!.passwordHash).toBe('hash:Distinta2027');
  });

  it('con la contraseña actual incorrecta → 401 y no cambia nada', async () => {
    const t = build();
    await expect(t.change.execute(t.driver.id, 'incorrecta1', 'Distinta2027')).rejects.toBeInstanceOf(UnauthorizedError);
    expect((await t.users.findCredentialsByEmployeeId('2001'))!.passwordHash).toBe('hash:Clave2026');
  });

  it('la nueva debe ser fuerte y distinta de la actual', async () => {
    const t = build();
    await expect(t.change.execute(t.driver.id, 'Clave2026', 'débil')).rejects.toBeInstanceOf(InvalidInputError);
    await expect(t.change.execute(t.driver.id, 'Clave2026', 'Clave2026')).rejects.toMatchObject({
      details: { reason: 'SAME_PASSWORD' },
    });
  });
});
