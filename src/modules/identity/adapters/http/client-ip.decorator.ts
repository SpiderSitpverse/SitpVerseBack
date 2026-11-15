import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { normalizeIp } from '../../../../shared/http/client-info';

/**
 * IP del cliente, LIMPIA. Detrás del balanceador de Azure `req.ip` llega como `1.2.3.4:51234` (con el puerto de origen, que cambia
 * en cada conexión) o como `::ffff:1.2.3.4`: usarla tal cual hace que cada petición parezca de un cliente distinto y el límite de
 * intentos por IP nunca se active. Aquí se normaliza, igual que en el registro de peticiones.
 */
export const ClientIp = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<{ ip?: string }>();
  return normalizeIp(request.ip) ?? 'desconocida';
});
