declare module 'geoip-country' {
  /** Busca el país de una IP (IPv4 o IPv6). `null` si es privada o no está en la base. */
  export function lookup(ip: string): { country: string } | null;
}
