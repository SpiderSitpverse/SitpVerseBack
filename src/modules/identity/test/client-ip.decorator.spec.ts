import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { ExecutionContext } from '@nestjs/common';
import { ClientIp } from '../adapters/http/client-ip.decorator';

/** Saca la función de la fábrica del decorador de parámetro, como lo hace Nest al resolver el argumento. */
function resolve(ip: string | undefined): string {
  class Probe {
    handler(@ClientIp() _ip: string) {}
  }
  const metadata = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'handler');
  const factory = Object.values(metadata)[0] as { factory: (data: unknown, ctx: ExecutionContext) => string };
  const ctx = { switchToHttp: () => ({ getRequest: () => ({ ip }) }) } as unknown as ExecutionContext;
  return factory.factory(undefined, ctx);
}

describe('ClientIp (ESC-SEG-01: el límite por IP depende de que la IP sea siempre la misma)', () => {
  it('detrás del balanceador de Azure la IP llega con el puerto de origen, que cambia en cada conexión: se quita', () => {
    expect(resolve('186.154.64.113:51234')).toBe('186.154.64.113');
    expect(resolve('186.154.64.113:60001')).toBe('186.154.64.113'); // otra conexión del mismo cliente: la MISMA clave
  });

  it('una IPv4 mapeada a IPv6 queda como IPv4', () => {
    expect(resolve('::ffff:10.0.0.7')).toBe('10.0.0.7');
  });

  it('una IP limpia no cambia, y sin IP no deja el límite sin clave', () => {
    expect(resolve('190.250.10.1')).toBe('190.250.10.1');
    expect(resolve(undefined)).toBe('desconocida');
  });
});
