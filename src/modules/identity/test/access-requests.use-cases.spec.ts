import { Logger } from '@nestjs/common';
import { ConflictError, InvalidInputError, NotFoundError } from '../../../shared/domain/errors';
import {
  ApproveAccessRequestUseCase,
  ListAccessRequestsUseCase,
  RejectAccessRequestUseCase,
} from '../application/access-requests.use-cases';
import { InMemoryAccessRequests } from './support/in-memory-access-requests';
import { InMemoryUsers } from './support/in-memory-users';

Logger.overrideLogger(false);

async function build() {
  const users = new InMemoryUsers();
  const admin = users.add('1001', 'Kevin', 'ADMIN', 'admin@gmail.com');
  const requests = new InMemoryAccessRequests(users);
  const open = async (n: number) => {
    const made = await requests.record(
      { subject: `sub-${n}`, email: `persona${n}@gmail.com`, name: `Persona ${n}`, firstName: null, lastName: null, photoUrl: null },
      200,
      () => ({ action: 'access.request', outcome: 'SUCCESS' }),
    );
    return made!.request;
  };
  return {
    users,
    admin,
    requests,
    open,
    list: new ListAccessRequestsUseCase(requests),
    approve: new ApproveAccessRequestUseCase(requests),
    reject: new RejectAccessRequestUseCase(requests),
  };
}

describe('Solicitudes de acceso: el administrador acepta y da el rol', () => {
  it('lista quién espera', async () => {
    const t = await build();
    await t.open(1);
    await t.open(2);
    expect((await t.list.execute()).map((r) => r.email)).toEqual(['persona1@gmail.com', 'persona2@gmail.com']);
  });

  it('aceptar crea el usuario con el rol elegido y el siguiente número libre del rol, y deja auditoría', async () => {
    const t = await build();
    const request = await t.open(1);
    const user = await t.approve.execute(t.admin, request.id, { role: 'DRIVER' }, '10.0.0.9');

    expect(user).toMatchObject({ role: 'DRIVER', employeeId: '2001', email: 'persona1@gmail.com', name: 'Persona 1', active: true });
    expect(await t.list.execute()).toEqual([]); // la solicitud se cierra
    expect(t.users.audit.records).toContainEqual(
      expect.objectContaining({ action: 'access.approve', outcome: 'SUCCESS', actorId: t.admin.id, resourceId: user.id, ip: '10.0.0.9' }),
    );
  });

  it('los números automáticos siguen la serie de cada rol (1002 admin, 2002 conductor, 3001 mecánico)', async () => {
    const t = await build();
    const ids: string[] = [];
    for (const [i, role] of (['ADMIN', 'DRIVER', 'DRIVER', 'MECHANICAL'] as const).entries()) {
      ids.push((await t.approve.execute(t.admin, (await t.open(i)).id, { role })).employeeId);
    }
    expect(ids).toEqual(['1002', '2001', '2002', '3001']);
  });

  it('el admin puede escoger el número de empleado y corregir el nombre', async () => {
    const t = await build();
    const user = await t.approve.execute(t.admin, (await t.open(1)).id, { role: 'MECHANICAL', employeeId: 'M-77', name: '  Gloria Herrera ' });
    expect(user).toMatchObject({ employeeId: 'M-77', name: 'Gloria Herrera' });
  });

  it('un número de empleado ya usado → 409 EMPLOYEE_ID_TAKEN y la solicitud sigue en espera', async () => {
    const t = await build();
    const request = await t.open(1);
    await expect(t.approve.execute(t.admin, request.id, { role: 'ADMIN', employeeId: '1001' })).rejects.toMatchObject({
      details: { reason: 'EMPLOYEE_ID_TAKEN' },
    });
    expect(await t.list.execute()).toHaveLength(1);
  });

  it('un número de empleado inválido → 400', async () => {
    const t = await build();
    await expect(t.approve.execute(t.admin, (await t.open(1)).id, { role: 'DRIVER', employeeId: 'con espacios' })).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('dos admins aceptan la MISMA solicitud a la vez: solo uno la acepta y el otro recibe 404', async () => {
    const t = await build();
    const request = await t.open(1);
    const results = await Promise.allSettled([
      t.approve.execute(t.admin, request.id, { role: 'DRIVER' }),
      t.approve.execute(t.admin, request.id, { role: 'MECHANICAL' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')[0]).toMatchObject({ reason: expect.any(NotFoundError) });
    expect([...t.users.rows.values()].filter((u) => u.email === 'persona1@gmail.com')).toHaveLength(1);
  });

  it('aceptar a varias personas a la vez no repite números: reintenta con el siguiente libre', async () => {
    const t = await build();
    t.requests.collideEmployeeIds = ['1001', '1001']; // otra aceptación simultánea se llevó esos números
    const user = await t.approve.execute(t.admin, (await t.open(1)).id, { role: 'ADMIN' });
    expect(user.employeeId).toBe('1002');
  });

  it('si el correo ya tiene cuenta → 409 EMAIL_TAKEN', async () => {
    const t = await build();
    const request = await t.open(1);
    t.users.add('2050', 'Ya existía', 'DRIVER', 'persona1@gmail.com'); // el admin la prerregistró mientras tanto
    await expect(t.approve.execute(t.admin, request.id, { role: 'DRIVER' })).rejects.toMatchObject({
      details: { reason: 'EMAIL_TAKEN' },
    });
  });

  it('aceptar una solicitud inexistente → 404', async () => {
    const t = await build();
    await expect(t.approve.execute(t.admin, '00000000-0000-4000-8000-000000000000', { role: 'DRIVER' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rechazar la deja marcada como RECHAZADA y audita; rechazarla otra vez → 400', async () => {
    const t = await build();
    const request = await t.open(1);
    await t.reject.execute(t.admin, request.id, '10.0.0.9');
    expect((await t.list.execute())[0].status).toBe('REJECTED');
    expect(t.users.audit.records).toContainEqual(
      expect.objectContaining({ action: 'access.reject', actorId: t.admin.id, resourceId: request.id, detail: { email: 'persona1@gmail.com' } }),
    );
    await expect(t.reject.execute(t.admin, request.id)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('rechazar una solicitud inexistente → 404', async () => {
    const t = await build();
    await expect(t.reject.execute(t.admin, '00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('una solicitud rechazada se puede aceptar después (el admin cambió de opinión)', async () => {
    const t = await build();
    const request = await t.open(1);
    await t.reject.execute(t.admin, request.id);
    const user = await t.approve.execute(t.admin, request.id, { role: 'DRIVER' });
    expect(user.role).toBe('DRIVER');
  });

  it('el reintento de números automáticos se rinde tras 5 intentos con 409', async () => {
    const t = await build();
    t.requests.collideEmployeeIds = ['1001', '1001', '1001', '1001', '1001'];
    await expect(t.approve.execute(t.admin, (await t.open(1)).id, { role: 'ADMIN' })).rejects.toBeInstanceOf(ConflictError);
  });
});
