import { CallHandler, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, throwError } from 'rxjs';
import { ConflictError, ForbiddenError } from '../../../shared/domain/errors';
import { currentRequestContext, runWithRequestContext } from '../../../shared/http/client-info';
import { AuditInterceptor } from '../adapters/http/audit.interceptor';
import { Audited } from '../adapters/http/audited';
import { AuthenticatedUser } from '../domain/models/authenticated-user';
import { InMemoryAudit } from './support/in-memory-users';

const driver: AuthenticatedUser = {
  id: 'u2',
  employeeId: '2001',
  name: 'Driver',
  role: 'DRIVER',
  email: 'driver@test.local',
  photoUrl: null,
};

class FakeController {
  @Audited('trip.start', 'bus', 'params.id') start() {}
  @Audited('inspection.register', 'bus', 'body.busId') inspect() {}
  plain() {}
}
const controller = new FakeController();

function context(handler: () => void, request: Record<string, unknown>) {
  return {
    getType: () => 'http',
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const request = (extra: Record<string, unknown> = {}) => ({
  method: 'PATCH',
  route: { path: '/fleet/buses/:id/start-trip' },
  params: { id: 'bus-1' },
  body: { busId: 'bus-9', photo: 'no debe guardarse' },
  user: driver,
  ...extra,
});

const run = <T>(work: () => Promise<T>) =>
  runWithRequestContext({ traceId: 'trace-1', ip: '10.0.0.1', country: null, userAgent: 'jest' }, work);

describe('AuditInterceptor (ESC-SEG-03)', () => {
  let audit: InMemoryAudit;
  let interceptor: AuditInterceptor;

  beforeEach(() => {
    audit = new InMemoryAudit();
    interceptor = new AuditInterceptor(new Reflector(), audit);
  });

  it('una acción crítica exitosa deja UN registro con quién, qué, sobre qué y el resultado', async () => {
    const next: CallHandler = { handle: () => of({ ok: true }) };
    const body = await run(() => lastValueFrom(interceptor.intercept(context(controller.start, request()), next)));

    expect(body).toEqual({ ok: true });
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      action: 'trip.start',
      outcome: 'SUCCESS',
      actorId: 'u2',
      actorEmail: 'driver@test.local',
      actorRole: 'DRIVER',
      resourceType: 'bus',
      resourceId: 'bus-1',
    });
  });

  it('deja el registro PENDIENTE en el contexto para que el adaptador lo inserte en su transacción, sin duplicarlo', async () => {
    const next: CallHandler = {
      handle: () => {
        // Lo que hace el adaptador dentro de la transacción del cambio.
        const pending = currentRequestContext()?.audit;
        expect(pending).toMatchObject({ action: 'trip.start', outcome: 'SUCCESS' });
        void audit.confirm(pending as never);
        return of('hecho');
      },
    };
    await run(() => lastValueFrom(interceptor.intercept(context(controller.start, request()), next)));
    expect(audit.records).toHaveLength(1);
  });

  it('el id del recurso puede venir del cuerpo; el cuerpo en sí nunca se guarda', async () => {
    const next: CallHandler = { handle: () => of(null) };
    await run(() => lastValueFrom(interceptor.intercept(context(controller.inspect, request()), next)));
    expect(audit.records[0]).toMatchObject({ action: 'inspection.register', resourceId: 'bus-9' });
    expect(JSON.stringify(audit.records[0])).not.toContain('no debe guardarse');
  });

  it('si la acción falla, queda el intento como FAILURE (y no como éxito) y el error se propaga', async () => {
    const error = new ConflictError('El bus ya está en servicio');
    const next: CallHandler = { handle: () => throwError(() => error) };
    await expect(
      run(() => lastValueFrom(interceptor.intercept(context(controller.start, request()), next))),
    ).rejects.toBe(error);

    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({ action: 'trip.start', outcome: 'FAILURE', actorId: 'u2' });
    expect(audit.records[0].detail).toMatchObject({ error: 'ConflictError' });
  });

  it.each([new ForbiddenError('No es tu bus'), new ForbiddenException('No es tu bus')])(
    'si la acción se rechaza por permisos, queda como DENIED',
    async (error) => {
      const next: CallHandler = { handle: () => throwError(() => error) };
      await expect(
        run(() => lastValueFrom(interceptor.intercept(context(controller.start, request()), next))),
      ).rejects.toBe(error);
      expect(audit.records[0]).toMatchObject({ outcome: 'DENIED', resourceId: 'bus-1' });
    },
  );

  it('un fallo al auditar el error no tapa el error original', async () => {
    const error = new ConflictError('choque');
    audit.failNextWrite = true;
    const next: CallHandler = { handle: () => throwError(() => error) };
    await expect(
      run(() => lastValueFrom(interceptor.intercept(context(controller.start, request()), next))),
    ).rejects.toBe(error);
  });

  it('las rutas sin @Audited y los contextos que no son HTTP no se tocan', async () => {
    const next: CallHandler = { handle: () => of('x') };
    await lastValueFrom(interceptor.intercept(context(controller.plain, request()), next));
    const ws = { getType: () => 'ws' } as unknown as ExecutionContext;
    await lastValueFrom(interceptor.intercept(ws, next));
    expect(audit.records).toHaveLength(0);
  });
});
