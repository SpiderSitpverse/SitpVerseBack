/**
 * PRESENTACIÓN: recorre los 15 usuarios de demostración y verifica, contra el servidor REAL,
 * que cada rol puede hacer lo suyo (y SOLO lo suyo): login, permisos por rol, ubicación en
 * tiempo real, subida de fotos de evidencia y alertas.
 *
 *   node scripts/load-tests/access-matrix.js [baseUrl]
 *
 * Requiere servidor corriendo y `npm run seed:reset` reciente. Escribe fotos de prueba en la
 * carpeta de subidas (UPLOADS_DIR, por defecto ./uploads).
 */
const fs = require('fs');
const path = require('path');
const { PASSWORD, tokenFor, makeApi, listen } = require('./lib');

const BASE = process.argv[2] ?? 'http://localhost:3000';
const api = makeApi(BASE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ADMINS = ['1001', '1002', '1003', '1004', '1005'];
const DRIVERS = ['2001', '2002', '2003', '2004', '2005'];
const MECHS = ['3001', '3002', '3003', '3004', '3005'];
const ROLE_OF = (id) => (id.startsWith('1') ? 'ADMIN' : id.startsWith('2') ? 'DRIVER' : 'MECHANICAL');

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
  if (!ok) failures++;
};
const section = (title) => console.log(`\n── ${title}`);

// PNG de 1x1 píxel (una foto válida mínima)
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function upload(as, incidentId, { buffer = PNG, type = 'image/png', name = 'foto.png', field = 'photo', caption } = {}) {
  const form = new FormData();
  if (buffer) form.append(field, new Blob([buffer], { type }), name);
  if (caption) form.append('caption', caption);
  const r = await fetch(`${BASE}/assistance/incidents/${incidentId}/evidence/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await tokenFor(BASE, as)}` },
    body: form,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

(async () => {
  // ───────────────────────── 1. Login de los 15 usuarios ─────────────────────────
  section('1. Inicio de sesión de los 15 usuarios');
  const everyone = [...ADMINS, ...DRIVERS, ...MECHS];
  const logins = await Promise.all(
    everyone.map((id) =>
      fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId: id, password: PASSWORD }),
      }).then(async (r) => ({ id, status: r.status, body: await r.json() })),
    ),
  );
  check('Los 15 usuarios inician sesión con su contraseña (200)', logins.every((l) => l.status === 200), `(${logins.filter((l) => l.status === 200).length}/15)`);
  check('Cada usuario tiene el rol correcto (5 ADMIN, 5 DRIVER, 5 MECHANICAL)',
    logins.every((l) => l.body.user?.role === ROLE_OF(l.id)));
  check('La respuesta trae accessToken y expiresIn, y NUNCA la contraseña ni su hash',
    logins.every((l) => l.body.accessToken && l.body.expiresIn > 0 && !JSON.stringify(l.body).match(/passwordHash|\$2[aby]\$/)));
  const wrong = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employeeId: '1001', password: 'incorrecta' }) });
  const unknown = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employeeId: '9999', password: 'incorrecta' }) });
  check('Contraseña incorrecta → 401', wrong.status === 401);
  check('Usuario inexistente → 401 con el MISMO mensaje (no revela qué números existen)',
    unknown.status === 401 && (await unknown.json()).message === (await wrong.json()).message);
  const me = await api('GET', '/auth/me', '2003');
  check('GET /auth/me devuelve quién soy según el token', me.status === 200 && me.body.employeeId === '2003' && me.body.role === 'DRIVER');
  check('Sin token → 401', (await api('GET', '/fleet/buses')).status === 401);
  check('El header viejo x-employee-id ya no sirve → 401',
    (await fetch(`${BASE}/fleet/buses`, { headers: { 'x-employee-id': '1001' } })).status === 401);

  // ───────────────────────── 2. Permisos por rol ─────────────────────────
  section('2. Permisos por rol (permitido ≠ 403 · prohibido = 403)');
  const buses = (await api('GET', '/fleet/buses', ADMINS[0])).body;
  const busOf = (plate) => buses.find((b) => b.plate === plate).id;
  const UUID = '00000000-0000-4000-8000-000000000000';
  const matrix = [
    // [descripción, método, ruta, roles permitidos]
    ['Listar buses', 'GET', '/fleet/buses', ['ADMIN', 'DRIVER', 'MECHANICAL']],
    ['Ver tablero de alertas', 'GET', '/assistance/calls', ['ADMIN', 'DRIVER', 'MECHANICAL']],
    ['Mi perfil y puntos', 'GET', '/assistance/me', ['ADMIN', 'DRIVER', 'MECHANICAL']],
    ['Ver bloqueos', 'GET', '/assistance/blockages', ['ADMIN', 'DRIVER', 'MECHANICAL']],
    ['Ver incidentes reportados', 'GET', '/assistance/incidents', ['ADMIN']],
    ['Reportes de grúas y cuadrillas', 'GET', '/assistance/tow-reports', ['ADMIN']],
    ['Home del conductor', 'GET', '/fleet/home/operativo', ['DRIVER']],
    ['Mis rutas alternativas asignadas', 'GET', '/assistance/routes/assigned/me', ['DRIVER']],
    ['Lanzar alerta de apoyo', 'POST', `/assistance/incidents/${UUID}/support-call`, ['ADMIN'], { slots: 1, rewardPoints: 1 }],
    ['Reportar incidente', 'POST', '/assistance/incidents', ['DRIVER'], {}],
    ['Reportar falla del bus', 'POST', '/assistance/bus-faults', ['DRIVER', 'ADMIN'], {}],
    ['Reportar bloqueo', 'POST', '/assistance/blockages', ['DRIVER', 'ADMIN'], {}],
    ['Alertar bloqueo a la flota', 'POST', `/assistance/blockages/${UUID}/alert`, ['ADMIN'], {}],
    ['Asignar grúa', 'POST', `/assistance/blockages/${UUID}/tow`, ['ADMIN'], {}],
    ['Proponer ruta alternativa', 'POST', `/assistance/incidents/${UUID}/routes`, ['ADMIN'], {}],
    ['Asignar ruta alternativa', 'POST', `/assistance/routes/${UUID}/assign`, ['ADMIN'], {}],
    ['Aceptar ruta alternativa', 'POST', `/assistance/routes/${UUID}/accept`, ['DRIVER'], {}],
    ['Aceptar una alerta (cupo)', 'POST', `/assistance/calls/${UUID}/accept`, ['DRIVER', 'MECHANICAL'], {}],
    ['Cancelar aceptación vencida', 'POST', `/assistance/calls/${UUID}/claims/${UUID}/cancel`, ['ADMIN'], {}],
    ['Reenviar alerta', 'POST', `/assistance/calls/${UUID}/resend`, ['ADMIN'], {}],
    ['Completar servicio', 'POST', `/assistance/calls/${UUID}/complete`, ['ADMIN', 'MECHANICAL'], {}],
    ['Ver evidencia de un incidente', 'GET', `/assistance/incidents/${UUID}/evidence`, ['ADMIN', 'DRIVER', 'MECHANICAL']],
  ];
  const sample = { ADMIN: ADMINS[2], DRIVER: DRIVERS[4], MECHANICAL: MECHS[3] }; // usuarios distintos de los demás flujos
  let wrongCount = 0;
  const problems = [];
  for (const [label, method, route, allowed, body] of matrix) {
    for (const role of ['ADMIN', 'DRIVER', 'MECHANICAL']) {
      const res = await api(method, route, sample[role], body);
      const ok = allowed.includes(role) ? res.status !== 403 && res.status !== 401 : res.status === 403;
      if (!ok) { wrongCount++; problems.push(`${label} [${role}] → ${res.status}`); }
    }
  }
  check(`Las ${matrix.length} acciones se permiten solo a los roles correctos (${matrix.length * 3} combinaciones)`, wrongCount === 0, problems.length ? `\n      ${problems.join('\n      ')}` : '');

  // ───────────────────────── 3. Ubicación en tiempo real ─────────────────────────
  section('3. Conductor activa su ubicación → el admin y el mecánico ven el mapa en vivo');
  const adminWs = await listen(BASE, ADMINS[0]);
  const mechWs = await listen(BASE, MECHS[0]);
  const driverWs = await listen(BASE, DRIVERS[1]);
  const rejected = await new Promise((resolve) => {
    const { io } = require('socket.io-client');
    const s = io(`${BASE}/realtime`, { auth: { token: 'token.falso.xyz' }, transports: ['websocket'] });
    s.on('unauthorized', () => resolve(true));
    s.on('disconnect', () => resolve(true));
    setTimeout(() => { s.close(); resolve(false); }, 4000);
  });
  check('Un socket con token falso es rechazado y desconectado', rejected);

  const home = await api('GET', '/fleet/home/operativo', DRIVERS[0]);
  check('El conductor 2001 ve su bus en su home', home.status === 200 && home.body.plate === 'TMX-001', `(${home.body.plate})`);
  const bus1 = home.body.busId;
  check('El conductor inicia su viaje (start-trip)', (await api('PATCH', `/fleet/buses/${bus1}/start-trip`, DRIVERS[0])).status === 200);
  for (let i = 0; i < 4; i++) {
    const r = await api('PATCH', `/fleet/buses/${bus1}/position`, DRIVERS[0], { latitude: 4.61 + i / 1000, longitude: -74.08 - i / 1000 });
    if (r.status !== 200) { check(`Posición ${i + 1} aceptada`, false, `(${r.status})`); }
  }
  await sleep(800);
  const mine = (ws) => ws.positions.filter((p) => p.busId === bus1);
  check('El ADMIN recibe las posiciones del bus en tiempo real', mine(adminWs).length >= 4, `(${mine(adminWs).length})`);
  check('El MECÁNICO también ve el mapa en tiempo real', mine(mechWs).length >= 4, `(${mine(mechWs).length})`);
  check('Otro CONDUCTOR no recibe las posiciones de la flota', mine(driverWs).length === 0);
  check('Un conductor no puede mover el bus de otro → 403', (await api('PATCH', `/fleet/buses/${bus1}/position`, DRIVERS[1], { latitude: 4.6, longitude: -74.1 })).status === 403);
  check('Un mecánico no puede mover un bus → 403', (await api('PATCH', `/fleet/buses/${bus1}/position`, MECHS[0], { latitude: 4.6, longitude: -74.1 })).status === 403);

  // ───────────────────────── 4. Incidente, evidencia fotográfica ─────────────────────────
  section('4. Incidente y subida de fotos de evidencia');
  const incident = await api('POST', '/assistance/incidents', DRIVERS[0], { busId: bus1, type: 'ACCIDENTE', description: 'Choque leve en la Calle 80' });
  check('El conductor reporta un incidente', incident.status === 201);
  await sleep(400);
  check('El ADMIN recibe la alerta del incidente en tiempo real', adminWs.events.some((e) => e.type === 'incident.reported'));
  check('El mecánico NO recibe los incidentes (solo administración)', !mechWs.events.some((e) => e.type === 'incident.reported'));

  const id = incident.body.id;
  const up = await upload(DRIVERS[0], id, { caption: 'Daño en la puerta delantera' });
  check('El CONDUCTOR sube una foto de evidencia → 201', up.status === 201 && /^\/uploads\/[0-9a-f-]{36}\.png$/.test(up.body.url ?? ''), `(${up.body.url})`);
  const served = await fetch(BASE + up.body.url);
  const servedBytes = Buffer.from(await served.arrayBuffer());
  check('La foto se puede abrir desde su URL (para <img src>) y es idéntica a la subida',
    served.status === 200 && (served.headers.get('content-type') ?? '').startsWith('image/png') && servedBytes.equals(PNG));
  check('El MECÁNICO sube una foto → 201', (await upload(MECHS[0], id, { caption: 'Revisión mecánica' })).status === 201);
  check('El ADMIN sube una foto → 201', (await upload(ADMINS[0], id)).status === 201);
  const list = await api('GET', `/assistance/incidents/${id}/evidence`, ADMINS[1]);
  check('La evidencia queda registrada con quién la subió (3 fotos)', list.status === 200 && list.body.length === 3 && list.body.every((e) => e.uploadedById && e.url));

  const fake = await upload(DRIVERS[0], id, { buffer: Buffer.from('<?php echo 1; ?>'), type: 'image/jpeg', name: 'virus.jpg' });
  check('Un archivo que NO es imagen (aunque diga image/jpeg) se rechaza → 400', fake.status === 400);
  const pdf = await upload(DRIVERS[0], id, { buffer: Buffer.from('%PDF-1.7 ...'), type: 'application/pdf', name: 'doc.pdf' });
  check('Un PDF se rechaza → 400', pdf.status === 400);
  const big = await upload(DRIVERS[0], id, { buffer: Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]), name: 'enorme.png' });
  check('Una imagen de más de 5 MB se rechaza → 413', big.status === 413);
  const none = await upload(DRIVERS[0], id, { buffer: null });
  check('Subir sin archivo → 400', none.status === 400);
  const uploadsDir = path.resolve(process.env.UPLOADS_DIR ?? 'uploads');
  const filesBefore = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir).length : -1;
  const ghost = await upload(DRIVERS[0], '00000000-0000-4000-8000-000000000000');
  const filesAfter = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir).length : -1;
  check('Subir a un incidente inexistente → 404 y NO deja el archivo huérfano', ghost.status === 404 && filesBefore === filesAfter, `(archivos ${filesBefore} → ${filesAfter})`);
  const traversal = await fetch(`${BASE}/uploads/..%2f..%2fpackage.json`);
  check('No se pueden leer archivos fuera de /uploads (path traversal)', traversal.status !== 200);
  const sinToken = await fetch(`${BASE}/assistance/incidents/${id}/evidence/upload`, { method: 'POST', body: new FormData() });
  check('Subir fotos sin iniciar sesión → 401', sinToken.status === 401);

  // ───────────────────────── 5. Concurrencia de alertas ─────────────────────────
  section('5. Alertas con cupos (concurrencia) con los usuarios reales');
  const call = await api('POST', `/assistance/incidents/${id}/support-call`, ADMINS[0], { slots: 2, rewardPoints: 25 });
  check('El admin lanza la alerta de apoyo (2 cupos, 25 puntos)', call.status === 201);
  await sleep(400);
  check('Los conductores reciben la alerta', driverWs.events.some((e) => e.type === 'call.opened'));
  check('Los mecánicos NO reciben la alerta de conductores', !mechWs.events.some((e) => e.type === 'call.opened'));
  const racers = DRIVERS.slice(1); // 2001 reportó el incidente y no puede aceptar el suyo
  const accepted = await Promise.all(racers.map((d) => api('POST', `/assistance/calls/${call.body.id}/accept`, d)));
  check('4 conductores aceptan a la vez: exactamente 2 se quedan con el cupo', accepted.filter((r) => r.status === 201).length === 2 && accepted.filter((r) => r.status === 409).length === 2,
    `(${accepted.map((r) => r.status)})`);
  check('El que reportó el incidente no puede aceptar su propia alerta → 403', (await api('POST', `/assistance/calls/${call.body.id}/accept`, DRIVERS[0])).status === 403);
  const detail = (await api('GET', '/assistance/calls', ADMINS[1])).body.find((c) => c.id === call.body.id);
  check('Cada aceptación trae su plazo de 20 minutos para llegar', detail.claims.length === 2 && detail.claims.every((c) => {
    const mins = (new Date(c.arriveBy) - Date.now()) / 60000;
    return mins > 19 && mins <= 20.1;
  }));
  const winner = DRIVERS.find((d, i) => accepted[i - 1]?.status === 201);
  const before = (await api('GET', '/assistance/me', winner)).body.points;
  await api('POST', `/assistance/calls/${call.body.id}/complete`, ADMINS[0]);
  check('Al completar, los ganadores cobran los 25 puntos', (await api('GET', '/assistance/me', winner)).body.points === before + 25);

  const fault = await api('POST', '/assistance/bus-faults', DRIVERS[0], { busId: bus1, description: 'Falla de frenos' });
  await sleep(400);
  check('Falla del bus: los MECÁNICOS reciben la alerta', fault.status === 201 && mechWs.events.some((e) => e.type === 'call.opened'));
  const repair = await Promise.all(MECHS.map((m) => api('POST', `/assistance/calls/${fault.body.call.id}/accept`, m)));
  check('5 mecánicos aceptan a la vez: gana exactamente 1', repair.filter((r) => r.status === 201).length === 1, `(${repair.map((r) => r.status)})`);
  const repairer = MECHS[repair.findIndex((r) => r.status === 201)];
  check('El mecánico que ganó completa la reparación y cobra el bono', (await api('POST', `/assistance/calls/${fault.body.call.id}/complete`, repairer)).status === 201
    && (await api('GET', '/assistance/me', repairer)).body.points === 50);

  [adminWs, mechWs, driverWs].forEach((w) => w.socket.close());
  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} verificación(es) fallaron`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
