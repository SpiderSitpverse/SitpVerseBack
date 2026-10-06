type Read = (key: string) => string | undefined;

/**
 * Comprueba la configuración que es OBLIGATORIA en producción y devuelve lo que falta (lista vacía = todo bien).
 * Es mejor que la app no arranque a que arranque insegura o apuntando a ningún lado.
 * (`JWT_SECRET` lo valida su propio servicio al crearse.)
 */
export function productionConfigProblems(get: Read): string[] {
  if (get('NODE_ENV') !== 'production') return [];

  const problems: string[] = [];
  const origins = (get('CORS_ORIGIN') ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  if (origins.length === 0 || origins.includes('*')) {
    problems.push('CORS_ORIGIN debe indicar la URL del front (no "*" ni vacío)');
  }
  if (!get('DATABASE_URL')) problems.push('DATABASE_URL es obligatoria');
  if (!get('REDIS_HOST') || get('REDIS_HOST') === 'localhost') {
    problems.push('REDIS_HOST debe apuntar al Redis de la nube (no a localhost)');
  }
  return problems;
}
