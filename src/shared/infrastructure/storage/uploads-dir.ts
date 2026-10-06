import { resolve } from 'path';

type Read = (key: string) => string | undefined;

/** En Azure App Service Linux, `/home` es el único disco que SOBREVIVE a reinicios y despliegues. */
export const AZURE_PERSISTENT_ROOT = '/home';

/** Azure App Service define esta variable en todas sus apps; fuera de Azure no existe. */
export const isAzureAppService = (get: Read) => Boolean(get('WEBSITE_SITE_NAME'));

/**
 * Dónde se guardan las fotos subidas:
 *  1. `UPLOADS_DIR`, si se definió (siempre manda);
 *  2. en Azure App Service, `/home/uploads` (así NO se pierden al reiniciar aunque nadie configure nada);
 *  3. en cualquier otro lugar (tu PC, CI), `./uploads`.
 */
export function resolveUploadsDir(get: Read): string {
  const explicit = get('UPLOADS_DIR')?.trim();
  if (explicit) return resolve(explicit);
  return isAzureAppService(get) ? `${AZURE_PERSISTENT_ROOT}/uploads` : resolve('uploads');
}

/**
 * Aviso si en Azure las fotos van a un lugar que se borra: devuelve el texto del aviso, o null si todo bien.
 * (No es un error que impida arrancar: la app funciona, solo perdería las fotos al reiniciar.)
 */
export function uploadsDirWarning(directory: string, get: Read): string | null {
  const normalized = directory.split('\\').join('/'); // por si llega con separadores de Windows
  const volatile = isAzureAppService(get) && !normalized.startsWith(`${AZURE_PERSISTENT_ROOT}/`);
  return volatile
    ? `Las fotos se guardan en "${directory}", fuera de ${AZURE_PERSISTENT_ROOT}: en Azure se perderán al reiniciar. ` +
        `Usa UPLOADS_DIR=${AZURE_PERSISTENT_ROOT}/uploads (o Blob Storage).`
    : null;
}
