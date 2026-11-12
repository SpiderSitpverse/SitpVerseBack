/**
 * SEGURIDAD de la API contra el servidor REAL (ESC-SEG-01 autenticación y ESC-SEG-03 trazabilidad):
 * cabeceras, ruta de salud, inicio de sesión con Google (ID tokens válidos e inválidos), límite por IP,
 * auditoría y su inmutabilidad.
 *
 *   node scripts/load-tests/fake-google.js &
 *   GOOGLE_JWKS_URI=http://127.0.0.1:4010/certs GOOGLE_CLIENT_ID=sitpverse-test.apps.googleusercontent.com \
 *     node dist/main.js &
 *   node scripts/load-tests/security.js [baseUrl]
 *
 * Requiere servidor, Redis, Postgres y el Google falso corriendo (DATABASE_URL en el entorno para la prueba de la
 * base). Usa correos y empleados ÚNICOS por ejecución. No necesita `npm run seed:reset`.
 */
const { io } = require('socket.io-client');
const { PrismaClient } = require('@prisma/client');
const { emailOf, fakeIp, getNonce, signIdToken, googleLogin, loginAs, tokenFor } = require('./lib');

const BASE = process.argv[2] ?? 'http://localhost:3000';
const uid = String(Date.now()).slice(-7);

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
  if (!ok) failures++;
};
const section = (t) => console.log(`\n── ${t}`);
const get = (path, token, headers = {}) =>
  fetch(`${BASE}${path}`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1];

/** Intento completo con un ID token firmado por el Google falso, con las variaciones que se pidan. */
async function attempt(token, { ip, nonce } = {}) {
  const useIp = ip ?? fakeIp();
  const n = nonce ?? (await getNonce(BASE, useIp));
  const idToken = await signIdToken({ email: emailOf('1004'), sub: 'sub-1004', nonce: n, ...token });
  return googleLogin(BASE, idToken, n, useIp);
}

(async () => {
  section('1. Ruta de salud');
  const health = await fetch(`${BASE}/health`);
  const body = await health.json();
  check('GET /health es pública y responde 200', health.status === 200 && body.status === 'ok', JSON.stringify(body.checks));
  check('Dice que la base de datos y Redis están arriba', body.checks.database === 'up' && body.checks.redis === 'up');
  check('No filtra datos sensibles (cadenas de conexión, versiones)', !/postgres|password|redis:\/\/|secret/i.test(JSON.stringify(body)));

  section('2. Cabeceras de seguridad (helmet)');
  const headers = (await get('/auth/me')).headers;
  check('X-Content-Type-Options: nosniff', headers.get('x-content-type-options') === 'nosniff');
  check('No anuncia el framework (sin X-Powered-By)', headers.get('x-powered-by') === null);
  check('Strict-Transport-Security presente', !!headers.get('strict-transport-security'));
  check('X-Frame-Options presente (anti-clickjacking)', !!headers.get('x-frame-options'));
  check('Las fotos pueden mostrarse desde otro origen (Cross-Origin-Resource-Policy: cross-origin)', headers.get('cross-origin-resource-policy') === 'cross-origin');

  section('3. ESC-SEG-01: ID tokens inválidos reciben 401');
  const ok = await attempt({});
  check('(control) un ID token válido de una cuenta prerregistrada entra → 200 con JWT de sesión', ok.status === 200 && !!ok.body.accessToken && ok.body.user.role === 'ADMIN', `(${ok.status})`);
  for (const [name, token] of [
    ['alterado: firmado con una llave que NO es de Google', { wrongKey: true }],
    ['vencido', { expiresInSeconds: -120 }],
    ['emitido para OTRA aplicación (audiencia distinta)', { aud: 'otra-app.apps.googleusercontent.com' }],
    ['de un emisor falso', { iss: 'https://accounts.evil.com' }],
    ['con el correo SIN verificar', { emailVerified: false }],
  ]) {
    const r = await attempt(token);
    check(`ID token ${name} → 401`, r.status === 401, `(${r.status})`);
  }
  const garbage = await googleLogin(BASE, 'esto.no.es-un-jwt-pero-es-largo-suficiente', await getNonce(BASE));
  check('Un texto que no es un JWT → 401', garbage.status === 401);
  const noBody = await fetch(`${BASE}/auth/google`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('Sin idToken ni nonce → 400', noBody.status === 400);
  const noneAlg = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"x"}').toString('base64url')}.`;
  check('Un token con alg:none → 401', (await googleLogin(BASE, noneAlg.padEnd(30, 'x'), await getNonce(BASE))).status === 401);

  section('3b. Nonce: una respuesta de Google no sirve dos veces');
  const ip = fakeIp();
  const nonce = await getNonce(BASE, ip);
  const idToken = await signIdToken({ email: emailOf('1004'), sub: 'sub-1004', nonce });
  const first = await googleLogin(BASE, idToken, nonce, ip);
  const replay = await googleLogin(BASE, idToken, nonce, ip);
  check('La primera vez entra → 200', first.status === 200);
  check('Repetir el MISMO ID token y nonce → 401', replay.status === 401, `(${replay.status})`);
  const fakeNonce = 'nonce-inventado-por-el-atacante-123456';
  const forged = await googleLogin(BASE, await signIdToken({ email: emailOf('1004'), sub: 'sub-1004', nonce: fakeNonce }), fakeNonce);
  check('Un nonce que el servidor nunca entregó → 401', forged.status === 401);
  const noNonceToken = await googleLogin(BASE, await signIdToken({ email: emailOf('1004'), sub: 'sub-1004' }), await getNonce(BASE));
  check('Un ID token sin nonce → 401', noNonceToken.status === 401);

  section('3c. Cuentas sin registro o desactivadas: 403 idéntico, sin sesión');
  const unknown = await attempt({ email: `desconocido${uid}@gmail.com`, sub: `sub-desc-${uid}` });
  const adminToken = await tokenFor(BASE, '1001');
  const mail = `seguridad${uid}@gmail.com`;
  const created = await fetch(`${BASE}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ employeeId: `SEC${uid}`, name: 'Usuario de prueba', role: 'DRIVER', email: mail }),
  }).then((r) => r.json());
  const enter = await attempt({ email: mail, sub: `sub-sec-${uid}` });
  await fetch(`${BASE}/users/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ active: false }),
  });
  const inactive = await attempt({ email: mail, sub: `sub-sec-${uid}` });
  check('Cuenta sin registro → 403 PENDING_APPROVAL (queda una solicitud en espera, sin rol ni sesión)', unknown.status === 403 && unknown.body.reason === 'PENDING_APPROVAL' && !unknown.body.accessToken);
  check('(preparación) la persona prerregistrada entra y luego se desactiva', enter.status === 200);
  check('Cuenta desactivada → 403', inactive.status === 403 && !inactive.body.accessToken);
  check('Los dos 403 llevan EL MISMO mensaje y motivo (no se sabe si una cuenta existió o fue dada de baja)', unknown.body.message === inactive.body.message && unknown.body.reason === inactive.body.reason);
  check('Su JWT de sesión anterior deja de valer en la siguiente petición → 401', (await get('/auth/me', enter.body.accessToken)).status === 401);

  section('3e. Solicitudes de acceso: el admin acepta y da el rol');
  const adminApi = (method, path, body) =>
    fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: body ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const newMail = `nuevo${uid}@gmail.com`;
  const newSub = `sub-nuevo-${uid}`;
  const firstTry = await attempt({ email: newMail, sub: newSub, givenName: 'Persona', familyName: 'Nueva' });
  const again = await attempt({ email: newMail, sub: newSub, givenName: 'Persona', familyName: 'Nueva' });
  check('La primera vez deja una solicitud en espera → 403 PENDING_APPROVAL', firstTry.status === 403 && firstTry.body.reason === 'PENDING_APPROVAL');
  check('Volver a intentarlo → el mismo 403 (sin duplicar la solicitud)', again.status === 403 && again.body.reason === 'PENDING_APPROVAL');
  const requests = await adminApi('GET', '/access-requests');
  const mine = Array.isArray(requests.body) ? requests.body.filter((r) => r.email === newMail) : [];
  check('El admin ve UNA solicitud con el nombre y la foto que trajo Google', requests.status === 200 && mine.length === 1 && mine[0].status === 'PENDING' && mine[0].name === 'Persona Nueva');
  check('Un conductor no puede ver las solicitudes → 403', (await get('/access-requests', await tokenFor(BASE, '2001'))).status === 403);
  check('Sin JWT → 401', (await get('/access-requests')).status === 401);
  check('Un conductor no puede aceptar solicitudes → 403', (await fetch(`${BASE}/access-requests/${mine[0].id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await tokenFor(BASE, '2001')}` }, body: JSON.stringify({ role: 'ADMIN' }) })).status === 403);
  check('Un rol inventado → 400', (await adminApi('POST', `/access-requests/${mine[0].id}/approve`, { role: 'SUPERUSER' })).status === 400);

  const [a1, a2] = await Promise.all([
    adminApi('POST', `/access-requests/${mine[0].id}/approve`, { role: 'MECHANICAL' }),
    adminApi('POST', `/access-requests/${mine[0].id}/approve`, { role: 'DRIVER' }),
  ]);
  const statuses = [a1.status, a2.status].sort();
  check('Dos aceptaciones simultáneas de la misma solicitud: una gana (201) y la otra pierde (404)', statuses[0] === 201 && statuses[1] === 404, `(${statuses})`);
  const approved = a1.status === 201 ? a1.body : a2.body;
  check('El usuario se crea con el rol elegido y un número de empleado automático', ['MECHANICAL', 'DRIVER'].includes(approved.role) && /^[23]\d{3}$/.test(approved.employeeId), JSON.stringify({ role: approved.role, employeeId: approved.employeeId }));
  const welcome = await attempt({ email: newMail, sub: newSub });
  check('En su siguiente intento entra con ese rol (200 + JWT)', welcome.status === 200 && welcome.body.user.role === approved.role && !!welcome.body.accessToken, `(${welcome.status})`);
  check('La solicitud desaparece de la lista', !(await adminApi('GET', '/access-requests')).body.some((r) => r.email === newMail));

  const rejMail = `rechazado${uid}@gmail.com`;
  await attempt({ email: rejMail, sub: `sub-rech-${uid}` });
  const rejReq = (await adminApi('GET', '/access-requests')).body.find((r) => r.email === rejMail);
  check('El admin rechaza una solicitud → 204', (await adminApi('POST', `/access-requests/${rejReq.id}/reject`)).status === 204);
  const afterReject = await attempt({ email: rejMail, sub: `sub-rech-${uid}` });
  check('La persona rechazada sigue sin entrar y se le dice → 403 ACCESS_REJECTED', afterReject.status === 403 && afterReject.body.reason === 'ACCESS_REJECTED');
  check('Rechazar de nuevo → 400', (await adminApi('POST', `/access-requests/${rejReq.id}/reject`)).status === 400);
  check('Aceptar una solicitud inexistente → 404', (await adminApi('POST', '/access-requests/00000000-0000-4000-8000-000000000000/approve', { role: 'DRIVER' })).status === 404);

  section('3d. Peticiones sin JWT de sesión (HTTP y WebSocket)');
  check('GET /fleet/buses sin JWT → 401', (await get('/fleet/buses')).status === 401);
  check('GET /fleet/buses con un JWT alterado → 401', (await get('/fleet/buses', `${adminToken.slice(0, -4)}AAAA`)).status === 401);
  const wsRejected = await new Promise((resolve) => {
    const s = io(`${BASE}/realtime`, { auth: {}, transports: ['websocket'], reconnection: false });
    s.on('identified', () => { s.close(); resolve(false); });
    s.on('unauthorized', () => { s.close(); resolve(true); });
    s.on('disconnect', () => resolve(true));
    s.on('connect_error', () => resolve(true));
    setTimeout(() => { s.close(); resolve(false); }, 4000);
  });
  check('Una conexión WebSocket sin JWT se rechaza', wsRejected);

  section('4. ESC-SEG-01: más de 10 intentos por minuto desde una IP → 429');
  const hammer = fakeIp();
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await attempt({ wrongKey: true }, { ip: hammer, nonce: 'n'.repeat(24) })).status);
  const limited = await attempt({}, { ip: hammer, nonce: 'n'.repeat(24) });
  check('Los 10 primeros intentos pasan por la verificación (401)', codes.slice(0, 10).every((c) => c === 401), `(${codes.slice(0, 10)})`);
  check('A partir del 11.º → 429', limited.status === 429 && limited.body.error === 'TOO_MANY_REQUESTS', `(${limited.status})`);
  const retry = Number(limited.headers.get('retry-after'));
  check('Responde con Retry-After (≤ 60 s)', retry > 0 && retry <= 60, `(${retry}s)`);
  check('Otra IP no se ve afectada', (await attempt({})).status === 200);
  check('El mismo límite protege GET /auth/nonce', (await fetch(`${BASE}/auth/nonce`, { headers: { 'X-Forwarded-For': hammer } })).status === 429);

  section('5. ESC-SEG-01: rendimiento del inicio de sesión (p95 ≤ 300 ms)');
  const times = [];
  for (let i = 0; i < 30; i++) {
    const useIp = fakeIp();
    const n = await getNonce(BASE, useIp);
    const tk = await signIdToken({ email: emailOf('1004'), sub: 'sub-1004', nonce: n });
    const t0 = performance.now();
    const r = await googleLogin(BASE, tk, n, useIp);
    times.push(performance.now() - t0);
    if (r.status !== 200) check('login de la medición', false, `(${r.status})`);
  }
  check('Verificación del ID token + emisión del JWT: p95 ≤ 300 ms', p95(times) <= 300, `(p95 = ${p95(times).toFixed(0)} ms)`);

  section('6. ESC-SEG-01: cero contraseñas');
  const prisma = new PrismaClient();
  const cols = (await prisma.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`).map((c) => c.column_name);
  check('La tabla users no tiene ninguna columna de contraseña ni hash', !cols.some((c) => /pass|hash|secret/i.test(c)), `(${cols.join(', ')})`);
  check('POST /auth/login (la ruta vieja) ya no existe → 404', (await fetch(`${BASE}/auth/login`, { method: 'POST' })).status === 404);

  section('7. ESC-SEG-03: auditoría');
  const audit = await get('/audit?limit=200', adminToken).then((r) => r.json());
  const has = (pred) => Array.isArray(audit) && audit.some(pred);
  check('El inicio de sesión exitoso queda registrado (quién, rol, IP, resultado)', has((a) => a.action === 'auth.login' && a.outcome === 'SUCCESS' && a.actorEmail && a.actorRole && a.ip));
  check('El ID token inválido queda registrado como DENIED con su motivo', has((a) => a.outcome === 'DENIED' && a.detail?.reason === 'INVALID_ID_TOKEN'));
  check('El nonce inválido queda registrado', has((a) => a.detail?.reason === 'INVALID_NONCE'));
  check('La cuenta desactivada queda registrada con su correo', has((a) => a.detail?.reason === 'ACCOUNT_DISABLED' && a.actorEmail === mail));
  check('La solicitud, su aceptación y su rechazo quedan registrados', has((a) => a.action === 'access.request' && a.actorEmail === newMail) && has((a) => a.action === 'access.approve' && a.actorRole === 'ADMIN') && has((a) => a.action === 'access.reject'));
  check('La creación y la desactivación del usuario quedan registradas con el admin como actor', has((a) => a.action === 'user.create' && a.resourceId === created.id) && has((a) => a.action === 'user.update' && a.resourceId === created.id && a.actorRole === 'ADMIN'));
  const t0 = performance.now();
  await get('/audit?limit=50', adminToken);
  check('El registro se consulta en 2 s o menos', performance.now() - t0 <= 2000, `(${(performance.now() - t0).toFixed(0)} ms)`);
  check('Filtra por acción y resultado', (await get('/audit?action=auth.login&outcome=DENIED', adminToken).then((r) => r.json())).every((a) => a.action === 'auth.login' && a.outcome === 'DENIED'));
  const driverToken = await tokenFor(BASE, '2001');
  check('Un conductor no puede consultar la auditoría → 403', (await get('/audit', driverToken)).status === 403);
  check('Sin JWT tampoco → 401', (await get('/audit')).status === 401);
  const row = audit[0];
  for (const method of ['PATCH', 'PUT', 'DELETE', 'POST']) {
    const r = await fetch(`${BASE}/audit/${row.id}`, { method, headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' });
    check(`${method} /audit/:id no existe (ni el admin puede modificar o borrar registros) → 404`, r.status === 404, `(${r.status})`);
  }
  let updateRejected = false, deleteRejected = false;
  try { await prisma.$executeRaw`UPDATE audit_log SET action = 'x' WHERE id = ${row.id}`; } catch (e) { updateRejected = /solo inserci/.test(String(e)); }
  try { await prisma.$executeRaw`DELETE FROM audit_log WHERE id = ${row.id}`; } catch (e) { deleteRejected = /solo inserci/.test(String(e)); }
  check('Aunque alguien tenga acceso directo a la base, UPDATE sobre audit_log es rechazado por la propia base', updateRejected);
  check('…y DELETE también', deleteRejected);
  section('8. ESC-SEG-03: TODAS las peticiones dejan hora, IP, usuario, navegador y país');
  const probeIp = '190.250.10.1';
  const agent = `SitpSecurityTest/${uid}`;
  const probe = (path, token) => fetch(`${BASE}${path}`, { headers: { 'X-Forwarded-For': probeIp, 'User-Agent': agent, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const okReq = await probe('/fleet/buses', driverToken);
  const noJwt = await probe('/fleet/buses');
  const forbidden = await probe('/users', driverToken);
  check('Cada respuesta trae su X-Trace-Id', [okReq, noJwt, forbidden].every((r) => /^[0-9a-f-]{36}$/.test(r.headers.get('x-trace-id') ?? '')));
  const logged = await get(`/audit/requests?ip=${probeIp}&limit=50`, adminToken).then((r) => r.json());
  const mineReqs = Array.isArray(logged) ? logged.filter((r) => r.userAgent === agent) : [];
  const byStatus = (st) => mineReqs.find((r) => r.status === st);
  check('Quedan las 3 peticiones: la correcta (200), la sin sesión (401) y la prohibida (403)', !!byStatus(200) && !!byStatus(401) && !!byStatus(403), `(${mineReqs.map((r) => r.status)})`);
  check('Cada registro trae la HORA, la IP, el NAVEGADOR y el PAÍS', mineReqs.length >= 3 && mineReqs.every((r) => r.at && r.ip === probeIp && r.userAgent === agent && r.country === 'CO'));
  check('…y el USUARIO cuando hay sesión (conductor 2001) y vacío cuando no', !!byStatus(200)?.userId && byStatus(200)?.role === 'DRIVER' && byStatus(401)?.userId === null);
  check('…con el método, la ruta, la duración y el trace_id', mineReqs.every((r) => r.method === 'GET' && r.path && Number.isInteger(r.durationMs) && r.traceId));
  check('El trace_id de la respuesta es el del registro (se rastrea un error hasta su log)', mineReqs.some((r) => r.traceId === okReq.headers.get('x-trace-id')));
  const hit = await get('/auth/nonce?secreto=XYZ', undefined, { 'X-Forwarded-For': probeIp, 'User-Agent': agent });
  const afterQuery = await get(`/audit/requests?ip=${probeIp}&path=/auth/nonce&limit=5`, adminToken).then((r) => r.json());
  check('La query (que podría traer datos) no se guarda: /auth/nonce?secreto=XYZ queda sin el secreto', hit.status === 200 && afterQuery.length > 0 && !JSON.stringify(afterQuery).includes('XYZ'));
  check('Filtra por país', (await get('/audit/requests?country=CO&limit=20', adminToken).then((r) => r.json())).every((r) => r.country === 'CO'));
  check('Un conductor no puede consultar el registro de peticiones → 403', (await get('/audit/requests', driverToken)).status === 403);
  check('Sin JWT → 401', (await get('/audit/requests')).status === 401);
  const auditNow = await get('/audit?action=auth.login&limit=50', adminToken).then((r) => r.json());
  check('La auditoría de acciones críticas también guarda IP, navegador, país y trace_id', auditNow.some((a) => a.ip && a.traceId && a.userAgent));
  let reqUpdateRejected = false, reqDeleteRejected = false;
  try { await prisma.$executeRaw`UPDATE request_log SET path = 'x' WHERE id = ${BigInt(logged[0].id)}`; } catch (e) { reqUpdateRejected = /solo inserci/.test(String(e)); }
  try { await prisma.$executeRaw`DELETE FROM request_log WHERE id = ${BigInt(logged[0].id)}`; } catch (e) { reqDeleteRejected = /solo inserci/.test(String(e)); }
  check('request_log es de solo inserción: UPDATE y DELETE los rechaza la propia base', reqUpdateRejected && reqDeleteRejected);
  section('9. Retención: las tablas siguen siendo de solo inserción, pero lo VENCIDO se puede purgar');
  const old = (days) => new Date(Date.now() - days * 24 * 3600 * 1000);
  const tag = `ret-${uid}`;
  await prisma.$executeRaw`INSERT INTO request_log (at, "traceId", method, path, status, "durationMs", ip) VALUES (${old(10)}, ${tag}, 'GET', '/viejo', 200, 1, '1.1.1.1'), (${old(3)}, ${tag}, 'GET', '/reciente', 200, 1, '1.1.1.1')`;
  await prisma.$executeRaw`INSERT INTO audit_log (id, at, action, outcome, "resourceType") VALUES (gen_random_uuid()::text, ${old(400)}, ${tag}, 'SUCCESS', 'test'), (gen_random_uuid()::text, ${old(100)}, ${tag}, 'SUCCESS', 'test')`;
  const rejected = async (sql) => { try { await sql; return false; } catch (e) { return /solo inserci/.test(String(e)); } };
  check('Una petición de 3 días NO se puede borrar (menos que el mínimo de 7)', await rejected(prisma.$executeRaw`DELETE FROM request_log WHERE "traceId" = ${tag} AND path = '/reciente'`));
  check('Una auditoría de 100 días NO se puede borrar (menos que el mínimo de 365)', await rejected(prisma.$executeRaw`DELETE FROM audit_log WHERE action = ${tag} AND at > ${old(200)}`));
  check('Un registro vencido tampoco se puede MODIFICAR (UPDATE siempre prohibido)', await rejected(prisma.$executeRaw`UPDATE request_log SET path = 'x' WHERE "traceId" = ${tag} AND path = '/viejo'`));
  const { PrismaService } = require('../../dist/shared/infrastructure/prisma.service');
  const { PrismaAuditLog } = require('../../dist/modules/identity/infrastructure/prisma/prisma-audit-log');
  const { LogRetentionService } = require('../../dist/modules/identity/infrastructure/prisma/log-retention.service');
  const db = new PrismaService();
  await db.$connect();
  const retention = new LogRetentionService(db, new PrismaAuditLog(db), { get: () => undefined });
  const purged = await retention.purge();
  check('La purga borra lo vencido (peticiones > 14 días no hay; la de 10 días se conserva)', purged.requestLog >= 0 && (await prisma.requestLog.count({ where: { traceId: tag } })) === 2);
  const retention7 = new LogRetentionService(db, new PrismaAuditLog(db), { get: (k) => (k === 'REQUEST_LOG_RETENTION_DAYS' ? 7 : k === 'AUDIT_RETENTION_DAYS' ? 365 : undefined) });
  const purged7 = await retention7.purge();
  const left = await prisma.requestLog.findMany({ where: { traceId: tag }, select: { path: true } });
  const auditLeft = await prisma.auditLog.findMany({ where: { action: tag }, select: { at: true } });
  check('Con el plazo mínimo (7 días) se purga la de 10 días y se conserva la de 3', purged7.requestLog >= 1 && left.length === 1 && left[0].path === '/reciente', JSON.stringify(left));
  check('La auditoría de 400 días se purga y la de 100 se conserva', purged7.auditLog >= 1 && auditLeft.length === 1);
  check('La purga deja su propia constancia en la auditoría', (await prisma.auditLog.count({ where: { action: 'retention.purge' } })) >= 1);
  await db.$disconnect();
  await prisma.$disconnect();

  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} verificación(es) fallaron`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
