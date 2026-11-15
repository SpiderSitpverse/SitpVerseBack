/**
 * Utilidades comunes de las pruebas contra el servidor REAL: inicia sesión con Google (contra el "Google" falso de
 * `fake-google.js`) una vez por usuario y arma peticiones y sockets con el token.
 *
 * Requiere: `node scripts/load-tests/fake-google.js` y el servidor arrancado con
 *   GOOGLE_JWKS_URI=http://127.0.0.1:4010/certs  GOOGLE_CLIENT_ID=sitpverse-test.apps.googleusercontent.com
 * Los usuarios de demostración entran con `<empleado>@sitpverse.local` (el seed de pruebas no define SEED_*_EMAIL).
 */
const { io } = require('socket.io-client');

const FAKE_GOOGLE = process.env.FAKE_GOOGLE_URL ?? 'http://127.0.0.1:4010';
const tokens = new Map(); // `${base}|${employeeId}` → Promise<accessToken>

/** Correo con el que entra cada usuario de demostración. */
const emailOf = (employeeId) => `${employeeId}@sitpverse.local`.toLowerCase();

// Arranca en un punto al azar: dos ejecuciones seguidas no repiten IP (el límite por IP dura 1 minuto).
let counter = Math.floor(Math.random() * 0xffffff);
/** Cada inicio de sesión sale de una IP distinta (X-Forwarded-For): el límite por IP no se mezcla entre usuarios de prueba. */
const fakeIp = () => {
  counter = (counter + 1) & 0xffffff;
  return `10.${(counter >> 16) & 255}.${(counter >> 8) & 255}.${counter & 255}`;
};

/** Pide un nonce al servidor. */
async function getNonce(base, ip = fakeIp()) {
  const r = await fetch(`${base}/auth/nonce`, { headers: { 'X-Forwarded-For': ip } });
  return (await r.json()).nonce;
}

/** El Google falso firma un ID token con lo que se pida (ver `fake-google.js`). */
async function signIdToken(spec) {
  const r = await fetch(`${FAKE_GOOGLE}/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
  });
  return (await r.json()).idToken;
}

/** POST /auth/google. Devuelve { status, body, headers }. */
async function googleLogin(base, idToken, nonce, ip = fakeIp()) {
  const r = await fetch(`${base}/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ idToken, nonce }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
}

/** Inicio de sesión completo como `employeeId` (o con un correo propio). Devuelve { status, body, headers }. */
async function loginAs(base, employeeId, over = {}) {
  const ip = over.ip ?? fakeIp();
  const nonce = over.nonce ?? (await getNonce(base, ip));
  const idToken = await signIdToken({
    email: over.email ?? emailOf(employeeId),
    sub: over.sub ?? `sub-${employeeId}`,
    nonce,
    ...over.token,
  });
  return googleLogin(base, idToken, nonce, ip);
}

/** Devuelve el token de sesión del usuario, iniciando sesión la primera vez. */
function tokenFor(base, employeeId, email) {
  const key = `${base}|${employeeId}|${email ?? ''}`;
  if (!tokens.has(key)) {
    tokens.set(
      key,
      loginAs(base, employeeId, email ? { email } : {}).then((r) => {
        if (r.status !== 200) throw new Error(`login ${employeeId} falló (${r.status}): ${r.body.message}`);
        return r.body.accessToken;
      }),
    );
  }
  return tokens.get(key);
}

/** Petición JSON autenticada como `employeeId` (sin `employeeId` va sin token). */
function makeApi(base) {
  return async (method, path, employeeId, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (employeeId) headers.Authorization = `Bearer ${await tokenFor(base, employeeId)}`;
    const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
}

/** Abre un socket autenticado y espera a que el servidor lo identifique. Devuelve { socket, events, positions }. */
async function listen(base, employeeId, lastSeq) {
  const events = [];
  const positions = [];
  const token = await tokenFor(base, employeeId);
  const socket = io(`${base}/realtime`, { auth: { token, lastSeq }, transports: ['websocket'] });
  socket.on('assistance:event', (e) => events.push(e));
  socket.on('fleet:position-updated', (e) => positions.push(e));
  await new Promise((resolve, reject) => {
    socket.on('identified', resolve);
    socket.on('unauthorized', () => reject(new Error(`socket de ${employeeId} rechazado`)));
  });
  return { socket, events, positions };
}

/**
 * Cliente HTTP con conexiones PERSISTENTES (keep-alive), como las de un cliente real: cada bus o navegador mantiene su
 * conexión abierta y no paga el saludo TCP/TLS en cada petición. `fetch` abre una conexión nueva por cada petición
 * simultánea, y contra un despliegue remoto eso mide el saludo TLS, no el sistema.
 *
 *   const client = makeClient(base, 100);
 *   await client.warmUp(100);                       // abre las conexiones antes de medir
 *   const r = await client.call('PATCH', '/fleet/buses/x/position', token, { latitude, longitude });
 *   // r = { status, body, durationMs, headers }   (status 0 si la petición no llegó a completarse)
 */
function makeClient(base, maxSockets = 64) {
  const url = new URL(base);
  const transport = url.protocol === 'https:' ? require('https') : require('http');
  const agent = new transport.Agent({ keepAlive: true, maxSockets, maxFreeSockets: maxSockets });

  const call = (method, path, token, body, extraHeaders = {}) =>
    new Promise((resolve) => {
      const started = Date.now();
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers = { Accept: 'application/json', ...extraHeaders };
      if (payload !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      if (token) headers.Authorization = `Bearer ${token}`;
      const request = transport.request(
        { protocol: url.protocol, hostname: url.hostname, port: url.port || undefined, path, method, agent, headers, timeout: 30_000 },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => (text += chunk));
          response.on('end', () => {
            let parsed = text;
            try { parsed = JSON.parse(text); } catch { /* texto plano (p. ej. /metrics) */ }
            resolve({ status: response.statusCode, body: parsed, durationMs: Date.now() - started, headers: response.headers });
          });
        },
      );
      request.on('timeout', () => request.destroy(new Error('timeout')));
      request.on('error', (error) => resolve({ status: 0, body: { error: error.message }, durationMs: Date.now() - started, headers: {} }));
      request.end(payload);
    });

  /** Abre `count` conexiones en paralelo (quedan abiertas) para que la medición no incluya el saludo TLS. */
  const warmUp = (count) => Promise.all(Array.from({ length: count }, () => call('GET', '/health/live')));

  return { call, warmUp, close: () => agent.destroy() };
}

/** Percentil `p` (0..1) de una lista de números; 0 si está vacía. */
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

module.exports = {
  makeClient,
  percentile, emailOf, fakeIp, getNonce, signIdToken, googleLogin, loginAs, tokenFor, makeApi, listen };
