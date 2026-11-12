export const ID_TOKEN_VERIFIER = Symbol('ID_TOKEN_VERIFIER');

/** Lo que Google afirma de una persona en un ID token ya verificado. */
export interface VerifiedIdentity {
  /** Identificador estable de la persona en Google (`sub`). */
  subject: string;
  email: string;
  emailVerified: boolean;
  givenName: string | null;
  familyName: string | null;
  picture: string | null;
  /** `nonce` que viajaba dentro del token (protege contra reutilizar una respuesta ya usada). */
  nonce: string | null;
}

/**
 * Puerto: verifica un ID token de OpenID Connect. Cambiar de proveedor de identidad toca solo este adapter.
 * Lanza `UnauthorizedError` si la firma, el emisor, la audiencia o el vencimiento no son válidos.
 */
export interface IdTokenVerifierPort {
  verify(idToken: string): Promise<VerifiedIdentity>;
}
