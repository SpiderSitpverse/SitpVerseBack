export const LOGIN_ATTEMPT_LIMITER = Symbol('LOGIN_ATTEMPT_LIMITER');

export interface LoginAttempt {
  employeeId: string;
  /** Dirección IP de quien intenta entrar. */
  ip: string;
}

/**
 * Puerto: freno a la fuerza bruta en el login (probar contraseñas una tras otra).
 *
 * Se cuentan los intentos FALLIDOS en tres ámbitos a la vez, para que ni un atacante simple ni uno
 * distribuido puedan seguir probando:
 *   - misma cuenta desde la misma IP        (límite bajo: 5 por defecto)
 *   - todas las cuentas desde una misma IP  (100 por defecto: barrido de usuarios; alto porque muchas personas pueden compartir una IP)
 *   - una misma cuenta desde cualquier IP   (20 por defecto: ataque distribuido a una persona)
 * Superado un límite, ese ámbito queda bloqueado un rato (15 min por defecto) aunque luego llegue la
 * contraseña correcta, y el cliente recibe 429 con el tiempo de espera.
 */
export interface LoginAttemptLimiterPort {
  /** Lanza `TooManyRequestsError` si alguno de los ámbitos está bloqueado. */
  assertNotBlocked(attempt: LoginAttempt): Promise<void>;
  /** Registra un intento fallido en los tres ámbitos. */
  recordFailure(attempt: LoginAttempt): Promise<void>;
  /** Tras un login correcto se borra el contador de esa cuenta desde esa IP. */
  recordSuccess(attempt: LoginAttempt): Promise<void>;
}
