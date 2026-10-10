import { ConfigService } from '@nestjs/config';
import { JwtTokenService } from '../infrastructure/security/jwt-token-service';

/** ConfigService mínimo: devuelve exactamente lo que haya en `values` (un valor vacío sigue siendo vacío). */
function config(values: Record<string, string>) {
  return { get: (key: string, fallback?: string) => (key in values ? values[key] : fallback) } as unknown as ConfigService;
}

const claims = { sub: 'user-1', role: 'ADMIN' as const, employeeId: '1001' };

describe('JwtTokenService · JWT_SECRET', () => {
  describe('en desarrollo', () => {
    it('sin JWT_SECRET usa el secreto de desarrollo y firma tokens que luego verifica', () => {
      const service = new JwtTokenService(config({}));
      const { accessToken } = service.issue(claims);
      expect(service.verify(accessToken)).toMatchObject({ sub: 'user-1', role: 'ADMIN', employeeId: '1001' });
    });

    it('con JWT_SECRET VACÍO (así queda al copiar .env.example) también usa el de desarrollo', () => {
      const service = new JwtTokenService(config({ JWT_SECRET: '' }));
      expect(() => service.issue(claims)).not.toThrow();
      expect(service.verify(service.issue(claims).accessToken)).not.toBeNull();
    });

    it('con un JWT_SECRET propio lo usa: un token firmado con otro secreto no se acepta', () => {
      const mine = new JwtTokenService(config({ JWT_SECRET: 'a'.repeat(40) }));
      const other = new JwtTokenService(config({ JWT_SECRET: 'b'.repeat(40) }));
      expect(mine.verify(other.issue(claims).accessToken)).toBeNull();
      expect(mine.verify(mine.issue(claims).accessToken)).not.toBeNull();
    });
  });

  describe('en producción', () => {
    it('sin JWT_SECRET no arranca', () => {
      expect(() => new JwtTokenService(config({ NODE_ENV: 'production' }))).toThrow(/obligatorio en producción/);
    });

    it('con JWT_SECRET vacío no arranca (no se cae al secreto de desarrollo)', () => {
      expect(() => new JwtTokenService(config({ NODE_ENV: 'production', JWT_SECRET: '' }))).toThrow(/obligatorio en producción/);
    });

    it('con un secreto de menos de 32 caracteres no arranca', () => {
      expect(() => new JwtTokenService(config({ NODE_ENV: 'production', JWT_SECRET: 'corto' }))).toThrow(/mínimo 32/);
    });

    it('con un secreto de 32 caracteres o más arranca', () => {
      expect(() => new JwtTokenService(config({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32) }))).not.toThrow();
    });
  });
});
