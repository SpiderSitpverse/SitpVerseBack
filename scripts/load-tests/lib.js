/**
 * Utilidades comunes de las pruebas contra el servidor REAL: inicia sesión con
 * `POST /auth/login` (una vez por usuario) y arma peticiones y sockets con el token.
 * La contraseña de los usuarios de demostración sale de SEED_PASSWORD (por defecto "Sitp2026!").
 */
const { io } = require('socket.io-client');

const PASSWORD = process.env.SEED_PASSWORD ?? 'Sitp2026!';
const tokens = new Map(); // `${base}|${employeeId}` → Promise<accessToken>

/** Devuelve el token del usuario, iniciando sesión la primera vez. */
function tokenFor(base, employeeId, password = PASSWORD) {
  const key = `${base}|${employeeId}|${password}`;
  if (!tokens.has(key)) {
    tokens.set(
      key,
      fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId, password }),
      }).then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(`login ${employeeId} falló (${r.status}): ${body.message}`);
        return body.accessToken;
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

module.exports = { PASSWORD, tokenFor, makeApi, listen };
