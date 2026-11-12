import { ConflictError, InvalidInputError, NotFoundError } from '../../../shared/domain/errors';
import {
  CreateUserUseCase,
  FindActiveUserUseCase,
  UpdateUserUseCase,
} from '../application/manage-users.use-cases';
import { AuthenticateTokenUseCase } from '../application/authenticate-token.use-case';
import { JwtTokenService } from '../infrastructure/security/jwt-token-service';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { InMemoryLock } from '../../../shared/testing/in-memory-lock';
import { InMemoryUsers } from './support/in-memory-users';

Logger.overrideLogger(false);

function build() {
  const users = new InMemoryUsers();
  const admin = users.add('1001', 'Admin Uno', 'ADMIN');
  const admin2 = users.add('1002', 'Admin Dos', 'ADMIN');
  const driver = users.add('2001', 'Conductor', 'DRIVER');
  return {
    users,
    admin,
    admin2,
    driver,
    create: new CreateUserUseCase(users),
    update: new UpdateUserUseCase(users, new InMemoryLock()),
    find: new FindActiveUserUseCase(users),
  };
}

const NEW = { employeeId: '3001', name: '  Mecánico  ', role: 'MECHANICAL' as const, email: '  Mecanico@Gmail.com ' };

describe('Prerregistrar usuarios (HU-04)', () => {
  it('crea la cuenta con el correo en minúsculas, sin contraseña, y deja su auditoría', async () => {
    const t = build();
    const created = await t.create.execute(t.admin, NEW, '10.0.0.1');

    expect(created).toMatchObject({ employeeId: '3001', name: 'Mecánico', role: 'MECHANICAL', email: 'mecanico@gmail.com', active: true });
    expect(JSON.stringify(created)).not.toMatch(/password|hash/i);
    expect(t.users.audit.records).toContainEqual(
      expect.objectContaining({ action: 'user.create', outcome: 'SUCCESS', actorId: t.admin.id, resourceId: created.id, ip: '10.0.0.1' }),
    );
  });

  it('rechaza un número de empleado o un correo repetidos con 409 (lo decide la base de datos)', async () => {
    const t = build();
    await expect(t.create.execute(t.admin, { ...NEW, employeeId: '2001' })).rejects.toMatchObject({
      details: { reason: 'EMPLOYEE_ID_TAKEN' },
    });
    await expect(t.create.execute(t.admin, { ...NEW, email: '2001@TEST.local' })).rejects.toMatchObject({
      details: { reason: 'EMAIL_TAKEN' },
    });
  });

  it('dos altas simultáneas del mismo número: solo una se crea (y solo una deja auditoría)', async () => {
    const t = build();
    const before = t.users.audit.records.length;
    const results = await Promise.allSettled(
      [1, 2].map((i) => t.create.execute(t.admin, { ...NEW, employeeId: '4001', email: `x${i}@gmail.com` })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')[0]).toMatchObject({ reason: expect.any(ConflictError) });
    expect(t.users.audit.records.length - before).toBe(1);
  });

  it.each(['sin-arroba', 'a@b', 'con espacios@x.com', ''])('rechaza el correo %p con 400', async (email) => {
    const t = build();
    await expect(t.create.execute(t.admin, { ...NEW, email })).rejects.toBeInstanceOf(InvalidInputError);
  });

  it.each(['ab', 'con espacios', 'raro/id', 'x'.repeat(40)])('rechaza el número de empleado %p', async (employeeId) => {
    const t = build();
    await expect(t.create.execute(t.admin, { ...NEW, employeeId })).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe('Editar y desactivar (HU-05 / HU-06)', () => {
  it('cambia el rol (conductor → mecánico) y lo audita como cambio de rol con el antes y el después', async () => {
    const t = build();
    const updated = await t.update.execute(t.admin, t.driver.id, { role: 'MECHANICAL' });
    expect(updated.role).toBe('MECHANICAL');
    expect(t.users.audit.records).toContainEqual(
      expect.objectContaining({
        action: 'user.role_change',
        detail: expect.objectContaining({ before: expect.objectContaining({ role: 'DRIVER' }), after: expect.objectContaining({ role: 'MECHANICAL' }) }),
      }),
    );
  });

  it('cambiar el correo lo normaliza y rechaza uno ya usado', async () => {
    const t = build();
    expect((await t.update.execute(t.admin, t.driver.id, { email: ' Nuevo@Gmail.com' })).email).toBe('nuevo@gmail.com');
    await expect(t.update.execute(t.admin, t.driver.id, { email: '1001@test.local' })).rejects.toMatchObject({
      details: { reason: 'EMAIL_TAKEN' },
    });
  });

  it('un usuario desactivado no puede autenticarse ni con su token anterior', async () => {
    const t = build();
    const tokens = new JwtTokenService({ get: (k: string, d?: string) => ({ JWT_SECRET: 'x'.repeat(40) })[k] ?? d } as unknown as ConfigService);
    const { accessToken } = tokens.issue({ sub: t.driver.id, role: 'DRIVER', employeeId: '2001' });
    const authenticate = new AuthenticateTokenUseCase(tokens, t.users);

    await expect(authenticate.execute(accessToken)).resolves.toMatchObject({ id: t.driver.id });
    await t.update.execute(t.admin, t.driver.id, { active: false });

    await expect(authenticate.execute(accessToken)).resolves.toBeNull();
    await expect(t.users.findUnlinkedByEmail('2001@test.local')).resolves.toBeNull(); // tampoco puede iniciar sesión
    await expect(t.find.execute(t.driver.id)).resolves.toBeNull();
  });

  it('un admin no puede desactivarse ni quitarse el rol a sí mismo', async () => {
    const t = build();
    await expect(t.update.execute(t.admin, t.admin.id, { active: false })).rejects.toMatchObject({
      details: { reason: 'SELF_LOCKOUT' },
    });
    await expect(t.update.execute(t.admin, t.admin.id, { role: 'DRIVER' })).rejects.toBeInstanceOf(ConflictError);
  });

  it('nunca puede quedar el sistema sin un administrador activo', async () => {
    const t = build();
    await t.update.execute(t.admin, t.admin2.id, { active: false }); // queda 1 admin activo
    await expect(t.update.execute(t.admin2, t.admin.id, { active: false })).rejects.toMatchObject({
      details: expect.objectContaining({ reason: expect.stringMatching(/LAST_ADMIN|SELF_LOCKOUT/) }),
    });
    expect(await t.users.countActiveAdmins()).toBe(1);
  });

  it('dos admins se desactivan entre sí AL MISMO TIEMPO → solo uno lo logra (nunca quedan 0 administradores)', async () => {
    const t = build();
    const results = await Promise.allSettled([
      t.update.execute(t.admin, t.admin2.id, { active: false }),
      t.update.execute(t.admin2, t.admin.id, { active: false }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')[0]).toMatchObject({ reason: expect.any(ConflictError) });
    expect(await t.users.countActiveAdmins()).toBe(1);
  });

  it('10 administradores se desactivan a la vez: siempre queda al menos uno', async () => {
    const t = build();
    const admins = [t.admin, t.admin2, ...Array.from({ length: 8 }, (_, i) => t.users.add(`19${i}`, `Admin ${i}`, 'ADMIN'))];
    await Promise.allSettled(
      admins.map((a, i) => t.update.execute(a, admins[(i + 1) % admins.length].id, { active: false })),
    );
    expect(await t.users.countActiveAdmins()).toBeGreaterThanOrEqual(1);
  });

  it('editar un usuario que no existe → 404 y sin auditoría', async () => {
    const t = build();
    await expect(
      t.update.execute(t.admin, '00000000-0000-4000-8000-000000000000', { name: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(t.users.audit.records).toHaveLength(0);
  });
});
