import { ArgumentsHost } from '@nestjs/common';
import { LockTimeoutError } from '../domain/distributed-lock.port';
import { ConflictError, ForbiddenError, NotFoundError } from '../domain/errors';
import { BusNotInServiceError } from '../../modules/fleet/domain/entities/bus.entity';
import { AppErrorFilter } from './app-error.filter';

function run(error: Parameters<AppErrorFilter['catch']>[0]) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  new AppErrorFilter().catch(error, host);
  return { status: status.mock.calls[0][0], body: json.mock.calls[0][0] };
}

describe('AppErrorFilter: errores de dominio → HTTP', () => {
  it.each([
    [new NotFoundError('x'), 404],
    [new ConflictError('x'), 409],
    [new ForbiddenError('x'), 403],
    [new LockTimeoutError('k', 5000), 503],
    [new BusNotInServiceError('TMX-001'), 409], // antes respondía 500
  ])('%p → %i', (error, expected) => {
    expect(run(error).status).toBe(expected);
  });

  it('incluye código estable, mensaje y detalles en el cuerpo', () => {
    const { body } = run(new ConflictError('Cupos tomados', { reason: 'FULL' }));
    expect(body).toEqual({
      statusCode: 409,
      error: 'CONFLICT',
      message: 'Cupos tomados',
      reason: 'FULL',
    });
  });
});
