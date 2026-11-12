export const AUTH_NONCE_STORE = Symbol('AUTH_NONCE_STORE');

/**
 * Puerto: nonces de un solo uso para el inicio de sesión. El servidor entrega uno, el front lo pone en la petición
 * a Google y el ID token lo trae de vuelta; así una respuesta de Google ya usada (o robada) no sirve dos veces.
 * Viven en Redis, compartidos entre todas las instancias, y caducan solos.
 */
export interface AuthNonceStorePort {
  issue(): Promise<string>;
  /** true si el nonce existía y estaba vigente. Lo borra: solo se puede consumir UNA vez. */
  consume(nonce: string): Promise<boolean>;
}
