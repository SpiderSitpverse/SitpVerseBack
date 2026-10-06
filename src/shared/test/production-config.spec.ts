import { productionConfigProblems } from '../infrastructure/production-config';

const problems = (env: Record<string, string>) => productionConfigProblems((key) => env[key]);

const GOOD = {
  NODE_ENV: 'production',
  CORS_ORIGIN: 'https://sitpverse-front.azurestaticapps.net',
  DATABASE_URL: 'postgresql://u:p@db.postgres.database.azure.com:5432/sitpverse?sslmode=require',
  REDIS_HOST: 'sitpverse.eastus.redis.azure.net',
};

describe('Configuración obligatoria en producción', () => {
  it('con todo bien configurado no hay problemas', () => {
    expect(problems(GOOD)).toEqual([]);
  });

  it('fuera de producción no exige nada (desarrollo y pruebas)', () => {
    expect(problems({})).toEqual([]);
    expect(problems({ NODE_ENV: 'development', CORS_ORIGIN: '*' })).toEqual([]);
  });

  it.each([
    ['sin CORS_ORIGIN', { CORS_ORIGIN: '' }, /CORS_ORIGIN/],
    ['con CORS_ORIGIN="*"', { CORS_ORIGIN: '*' }, /CORS_ORIGIN/],
    ['con "*" entre varios orígenes', { CORS_ORIGIN: 'https://a.com, *' }, /CORS_ORIGIN/],
    ['sin DATABASE_URL', { DATABASE_URL: '' }, /DATABASE_URL/],
    ['con Redis en localhost', { REDIS_HOST: 'localhost' }, /REDIS_HOST/],
    ['sin REDIS_HOST', { REDIS_HOST: '' }, /REDIS_HOST/],
  ])('rechaza producción %s', (_name, override, expected) => {
    const found = problems({ ...GOOD, ...override });
    expect(found.length).toBeGreaterThan(0);
    expect(found.join(' ')).toMatch(expected);
  });

  it('acepta varios orígenes explícitos', () => {
    expect(problems({ ...GOOD, CORS_ORIGIN: 'https://a.com, https://b.com' })).toEqual([]);
  });

  it('informa TODOS los problemas a la vez (no de uno en uno)', () => {
    expect(problems({ NODE_ENV: 'production' })).toHaveLength(3);
  });
});
