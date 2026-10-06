export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

/** Puerto: cifrado y comparación de contraseñas (hoy bcrypt). */
export interface PasswordHasherPort {
  /** Cifra una contraseña para guardarla. */
  hash(plain: string): Promise<string>;
  /** Compara una contraseña en texto plano con su hash. */
  matches(plain: string, hash: string): Promise<boolean>;
}
