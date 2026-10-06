import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Public, Roles } from '../adapters/http/auth.decorators';
import { AuthGuard } from '../adapters/http/auth.guard';
import { AuthenticateTokenUseCase } from '../application/authenticate-token.use-case';
import { AuthenticatedUser } from '../domain/models/authenticated-user';

const tokens: Record<string, AuthenticatedUser> = {
  'token-admin': { id: 'u1', employeeId: '1001', name: 'Admin', role: 'ADMIN' },
  'token-driver': { id: 'u2', employeeId: '2001', name: 'Driver', role: 'DRIVER' },
};

class FakeController {
  @Roles('ADMIN') adminOnly() {}
  @Roles('ADMIN', 'DRIVER') both() {}
  @Public() open() {}
  forgotten() {} // sin política
}

function context(handler: () => void, authorization?: string) {
  const request: Record<string, unknown> = {
    headers: authorization ? { authorization } : {},
  };
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
  {
    execute: async (token?: string) => (token ? tokens[token] ?? null : null),
  } as unknown as AuthenticateTokenUseCase,
);
const controller = new FakeController();

describe('AuthGuard global (falla cerrado)', () => {
  it('ruta @Public pasa sin credenciales', async () => {
    await expect(guard.canActivate(context(controller.open).ctx)).resolves.toBe(true);
  });

  it('sin token → 401', async () => {
    await expect(guard.canActivate(context(controller.adminOnly).ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('token inválido → 401', async () => {
    await expect(
      guard.canActivate(context(controller.adminOnly, 'Bearer token-falso').ctx),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('el header antiguo x-employee-id ya NO autentica (era suplantable)', async () => {
    const { ctx, request } = context(controller.adminOnly);
    request.headers = { 'x-employee-id': '1001' };
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('un esquema distinto de Bearer no autentica', async () => {
    await expect(
      guard.canActivate(context(controller.adminOnly, 'Basic token-admin').ctx),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rol permitido pasa y deja el usuario en la petición', async () => {
    const { ctx, request } = context(controller.both, 'Bearer token-driver');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.user).toMatchObject({ role: 'DRIVER' });
  });

  it('acepta "bearer" en minúsculas (los clientes HTTP varían)', async () => {
    await expect(
      guard.canActivate(context(controller.both, 'bearer token-admin').ctx),
    ).resolves.toBe(true);
  });

  it('rol no permitido → 403', async () => {
    await expect(
      guard.canActivate(context(controller.adminOnly, 'Bearer token-driver').ctx),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('una ruta SIN política de acceso se rechaza aunque el usuario sea ADMIN (no queda abierta por olvido)', async () => {
    await expect(
      guard.canActivate(context(controller.forgotten, 'Bearer token-admin').ctx),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
