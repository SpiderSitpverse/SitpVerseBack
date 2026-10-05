import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Public, Roles } from '../adapters/http/auth.decorators';
import { AuthGuard } from '../adapters/http/auth.guard';
import { AuthenticateEmployeeUseCase } from '../application/authenticate-employee.use-case';
import { AuthenticatedUser } from '../domain/models/authenticated-user';

const users: Record<string, AuthenticatedUser> = {
  '1': { id: 'u1', employeeId: '1', name: 'Admin', role: 'ADMIN' },
  '2': { id: 'u2', employeeId: '2', name: 'Driver', role: 'DRIVER' },
};

class FakeController {
  @Roles('ADMIN') adminOnly() {}
  @Roles('ADMIN', 'DRIVER') both() {}
  @Public() open() {}
  forgotten() {} // sin política
}

function context(handler: () => void, employeeId?: string) {
  const request: Record<string, unknown> = { headers: employeeId ? { 'x-employee-id': employeeId } : {} };
  const ctx = {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => FakeController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { ctx, request };
}

const guard = new AuthGuard(
  new Reflector(),
  { execute: async (id?: string) => (id ? users[id] ?? null : null) } as unknown as AuthenticateEmployeeUseCase,
);
const controller = new FakeController();

describe('AuthGuard global (falla cerrado)', () => {
  it('ruta @Public pasa sin credenciales', async () => {
    await expect(guard.canActivate(context(controller.open).ctx)).resolves.toBe(true);
  });

  it('sin header → 401', async () => {
    await expect(guard.canActivate(context(controller.adminOnly).ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('empleado desconocido → 401', async () => {
    await expect(guard.canActivate(context(controller.adminOnly, '999').ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rol permitido pasa y deja el usuario en la petición', async () => {
    const { ctx, request } = context(controller.both, '2');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.user).toMatchObject({ role: 'DRIVER' });
  });

  it('rol no permitido → 403', async () => {
    await expect(guard.canActivate(context(controller.adminOnly, '2').ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('una ruta SIN política de acceso se rechaza aunque el usuario sea ADMIN (no queda abierta por olvido)', async () => {
    await expect(guard.canActivate(context(controller.forgotten, '1').ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
