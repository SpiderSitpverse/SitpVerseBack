import { AsyncLocalStorage } from 'async_hooks';
import { lookup } from 'geoip-country';

/** Datos de QUIÉN llama, que se guardan en cada petición y en cada registro de auditoría (ESC-SEG-03). */
export interface RequestContext {
  traceId: string;
  ip: string | null;
  /** Código ISO del país de la IP (p. ej. `CO`); null si es una IP privada o no está en la base. */
  country: string | null;
  /** Navegador o aplicación (cabecera `User-Agent`), recortado. */
  userAgent: string | null;
}

/**
 * La petición en curso. Así la auditoría sabe desde qué IP, país y navegador se hizo cada acción SIN que cada caso de uso
 * tenga que recibirlos como parámetro: se leen del contexto de la petición que está corriendo.
 */
const storage = new AsyncLocalStorage<RequestContext>();

export const runWithRequestContext = <T>(context: RequestContext, work: () => T): T => storage.run(context, work);
export const currentRequestContext = (): RequestContext | undefined => storage.getStore();

const MAX_USER_AGENT = 300;
const PORT_SUFFIX = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/;

/**
 * IP limpia del cliente. Detrás del proxy de Azure, `X-Forwarded-For` trae `ip:puerto` (IPv4) y las IPv4 pueden llegar
 * mapeadas a IPv6 (`::ffff:1.2.3.4`): se dejan como `1.2.3.4`.
 */
export function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length);
  const withPort = PORT_SUFFIX.exec(ip);
  if (withPort) ip = withPort[1];
  return ip.length > 0 && ip.length <= 64 ? ip : null;
}

export function countryOf(ip: string | null): string | null {
  if (!ip) return null;
  try {
    return lookup(ip)?.country ?? null;
  } catch {
    return null;
  }
}

/** Texto de la cabecera `User-Agent` sin caracteres de control (no se puede falsificar una línea de log) y recortado. */
export function cleanUserAgent(raw: string | undefined | null): string | null {
  if (!raw) return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_USER_AGENT);
  return cleaned.length > 0 ? cleaned : null;
}
