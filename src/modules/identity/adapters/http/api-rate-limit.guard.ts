import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { API_RATE_LIMITER, ApiRateLimiterPort } from '../../domain/ports/api-rate-limiter.port';
import { PUBLIC_KEY } from './auth.decorators';
import { RATE_LIMIT_KEY, RateLimitSpec } from './rate-limit.decorator';

const DEFAULT_PER_MINUTE = 600;

/**
 * Límite de peticiones por USUARIO en toda la API (ESC-SEG-01: protección ante abuso). Va DESPUÉS del `AuthGuard`, así que ya
 * sabe quién es. Las rutas públicas (salud, métricas y el inicio de sesión, que tiene su propio límite por IP) no pasan por aquí.
 *
 *   - Por defecto `RATE_LIMIT_PER_MINUTE` (600) peticiones por minuto y usuario: 10 por segundo, muy por encima de lo que hace
 *     una persona o la app de un conductor (una posición cada 3 s).
 *   - Una ruta puede ser más estricta con `@RateLimit(n, 'grupo')` (p. ej. subir fotos).
 */
@Injectable()
export class ApiRateLimitGuard implements CanActivate {
  private readonly perMinute: number;

  constructor(
    private readonly reflector: Reflector,
    @Inject(API_RATE_LIMITER) private readonly limiter: ApiRateLimiterPort,
    config: ConfigService,
  ) {
    this.perMinute = Number(config.get('RATE_LIMIT_PER_MINUTE', DEFAULT_PER_MINUTE));
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;
    const user = ctx.switchToHttp().getRequest().user as { id: string } | undefined;
    if (!user) return true; // el AuthGuard ya rechazó lo que no tiene sesión

    const spec = this.reflector.get<RateLimitSpec | undefined>(RATE_LIMIT_KEY, ctx.getHandler());
    await this.limiter.assertAllowed(`user:${user.id}`, 'api', this.perMinute);
    if (spec) await this.limiter.assertAllowed(`user:${user.id}`, spec.bucket, spec.perMinute);
    return true;
  }
}
