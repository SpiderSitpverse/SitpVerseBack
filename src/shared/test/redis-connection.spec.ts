import { buildRedisOptions, readRedisSettings } from '../infrastructure/redis-connection';

const settingsFrom = (env: Record<string, string>) => readRedisSettings((key) => env[key]);

describe('Conexión a Redis (local vs Azure)', () => {
  it('sin variables usa Redis local: localhost:6379, sin contraseña y sin TLS', () => {
    const options = buildRedisOptions(settingsFrom({}));
    expect(options).toEqual({ host: 'localhost', port: 6379 });
    expect(options).not.toHaveProperty('tls');
    expect(options).not.toHaveProperty('password');
  });

  it('con la configuración de Azure: host, puerto, clave y TLS verificando el certificado por nombre', () => {
    const options = buildRedisOptions(
      settingsFrom({
        REDIS_HOST: 'sitpverse.eastus.redis.azure.net',
        REDIS_PORT: '10000',
        REDIS_PASSWORD: 'clave-de-acceso',
        REDIS_TLS: 'true',
      }),
    );
    expect(options).toEqual({
      host: 'sitpverse.eastus.redis.azure.net',
      port: 10000,
      password: 'clave-de-acceso',
      tls: { servername: 'sitpverse.eastus.redis.azure.net' },
    });
  });

  it.each(['true', 'TRUE', ' true '])('REDIS_TLS=%p activa TLS', (value) => {
    expect(buildRedisOptions(settingsFrom({ REDIS_TLS: value }))).toHaveProperty('tls');
  });

  it.each(['false', '', '0', 'si', undefined])('REDIS_TLS=%p NO activa TLS (solo "true")', (value) => {
    expect(buildRedisOptions(settingsFrom(value === undefined ? {} : { REDIS_TLS: value }))).not.toHaveProperty('tls');
  });

  it('una variable vacía cuenta como no definida (p. ej. REDIS_PASSWORD= en el .env)', () => {
    const options = buildRedisOptions(settingsFrom({ REDIS_PASSWORD: '', REDIS_USERNAME: '  ', REDIS_HOST: '' }));
    expect(options).toEqual({ host: 'localhost', port: 6379 });
  });

  it('las opciones propias de cada conexión (p. ej. el relay sin cola de espera) se conservan', () => {
    const options = buildRedisOptions(settingsFrom({ REDIS_PASSWORD: 'x' }), { enableOfflineQueue: false });
    expect(options).toMatchObject({ password: 'x', enableOfflineQueue: false });
  });

  it('soporta usuario (ACL) además de contraseña', () => {
    expect(buildRedisOptions(settingsFrom({ REDIS_USERNAME: 'app', REDIS_PASSWORD: 'x' }))).toMatchObject({ username: 'app', password: 'x' });
  });
});
