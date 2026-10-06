/**
 * SEGURIDAD de la API contra el servidor REAL: cabeceras, ruta de salud y freno a la fuerza bruta del login.
 *
 *   node scripts/load-tests/security.js [baseUrl]
 *
 * Requiere servidor y Redis corriendo. Usa un número de empleado ÚNICO por ejecución para que el bloqueo
 * de una corrida no afecte a la siguiente. No necesita `npm run seed:reset`.
 */
const { PASSWORD } = require('./lib');

const BASE = process.argv[2] ?? 'http://localhost:3000';
const uid = String(Date.now()).slice(-7);

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
  if (!ok) failures++;
};
const section = (t) => console.log(`\n── ${t}`);

const login = (employeeId, password) =>
  fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId, password }),
  });

(async () => {
  section('1. Ruta de salud');
  const health = await fetch(`${BASE}/health`);
  const body = await health.json();
  check('GET /health es pública y responde 200', health.status === 200 && body.status === 'ok', JSON.stringify(body.checks));
  check('Dice que la base de datos y Redis están arriba', body.checks.database === 'up' && body.checks.redis === 'up');
  check('No filtra datos sensibles (cadenas de conexión, versiones)', !/postgres|password|redis:\/\/|secret/i.test(JSON.stringify(body)));

  section('2. Cabeceras de seguridad (helmet)');
  const headers = (await fetch(`${BASE}/auth/me`)).headers;
  check('X-Content-Type-Options: nosniff', headers.get('x-content-type-options') === 'nosniff');
  check('No anuncia el framework (sin X-Powered-By)', headers.get('x-powered-by') === null);
  check('Strict-Transport-Security presente', !!headers.get('strict-transport-security'));
  check('X-Frame-Options presente (anti-clickjacking)', !!headers.get('x-frame-options'));
  check('Las fotos pueden mostrarse desde otro origen (Cross-Origin-Resource-Policy: cross-origin)', headers.get('cross-origin-resource-policy') === 'cross-origin');

  section('3. Freno a la fuerza bruta en el login');
  const victim = `ZZ${uid}`;
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await login(victim, `incorrecta${i}`)).status);
  check('Los primeros 5 intentos fallidos responden 401', codes.every((c) => c === 401), `(${codes})`);

  const blocked = await login(victim, 'incorrecta-6');
  const blockedBody = await blocked.json();
  const retryAfter = Number(blocked.headers.get('retry-after'));
  check('El 6.º intento se bloquea → 429', blocked.status === 429 && blockedBody.error === 'TOO_MANY_REQUESTS', `(${blocked.status})`);
  check('Responde con Retry-After (segundos de espera, ≤ 15 min)', retryAfter > 0 && retryAfter <= 900, `(${retryAfter}s)`);
  check('El cuerpo trae retryAfterSeconds para que el front muestre la cuenta regresiva', blockedBody.retryAfterSeconds === retryAfter);

  // Una cuenta REAL (creada solo para esta prueba, para no bloquear a los usuarios de las demás) con la
  // contraseña CORRECTA, atacada desde esta misma IP: el bloqueo no debe dejar pasar al atacante aunque "acierte".
  const adminToken = (await (await login('1001', PASSWORD)).json()).accessToken;
  const real = `SEC${uid}`;
  const created = await fetch(`${BASE}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ employeeId: real, name: 'Usuario de prueba', role: 'DRIVER', password: 'Prueba2026ok' }),
  });
  check('(preparación) se crea un usuario real de usar y tirar', created.status === 201);
  for (let i = 0; i < 5; i++) await login(real, `incorrecta${i}`);
  const stillBlocked = await login(real, 'Prueba2026ok');
  check('Con la contraseña CORRECTA, una cuenta bloqueada tampoco entra → 429', stillBlocked.status === 429, `(${stillBlocked.status})`);
  const sinMinutos = (m) => m.replace(/\d+/g, 'N'); // el mensaje dice cuántos minutos faltan: puede diferir en 1
  const message = sinMinutos((await stillBlocked.json()).message);

  const ghost = `ZY${uid}`;
  for (let i = 0; i < 5; i++) await login(ghost, 'x');
  const ghostBlocked = await login(ghost, 'x');
  check('Un empleado INEXISTENTE se frena igual que uno real: mismo código y mismo mensaje (no revela cuáles existen)',
    ghostBlocked.status === 429 && sinMinutos((await ghostBlocked.json()).message) === message);

  const otherAccount = await login('1004', PASSWORD);
  check('Otra cuenta desde la misma IP sigue funcionando (el bloqueo es por cuenta, no por equipo)', otherAccount.status === 200, `(${otherAccount.status})`);

  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} verificación(es) fallaron`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
