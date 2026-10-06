/**
 * FLUJOS DEL FRONT contra el servidor REAL: reproduce lo que hace cada pantalla de SitpVerseFront.
 *
 *   node scripts/load-tests/front-flows.js [baseUrl]
 *
 * Requiere servidor corriendo y `npm run seed:reset` reciente. Crea usuarios y buses con sufijo único,
 * así que se puede repetir sin limpiar. Escribe fotos de prueba en la carpeta de subidas.
 */
const { PASSWORD, tokenFor, makeApi } = require('./lib');

const BASE = process.argv[2] ?? 'http://localhost:3000';
const ORIGIN = 'http://localhost:5173'; // donde corre el front con Vite
const api = makeApi(BASE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = String(Date.now()).slice(-7); // sufijo para que el script se pueda repetir

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
  if (!ok) failures++;
};
const section = (t) => console.log(`\n── ${t}`);

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Sube una foto como lo hará el front (POST /files/images) y devuelve su URL. */
async function uploadPhoto(as, buffer = PNG, type = 'image/png') {
  const form = new FormData();
  form.append('photo', new Blob([buffer], { type }), 'foto.png');
  const r = await fetch(`${BASE}/files/images`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await tokenFor(BASE, as)}` },
    body: form,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const login = (employeeId, password) =>
  fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId, password }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

(async () => {
  const ADMIN = '1001', ADMIN2 = '1002';
  const DRIVER_A = '2001', DRIVER_B = '2002', DRIVER_C = '2003';
  const MECH_A = '3001', MECH_B = '3002';

  // ───────────────────────── 0. CORS (el navegador lo exige) ─────────────────────────
  section('0. CORS: el front en el navegador puede llamar al back');
  const preflight = await fetch(`${BASE}/auth/login`, {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
  });
  check('El preflight desde http://localhost:5173 se acepta', preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === ORIGIN,
    `(${preflight.status}, origin=${preflight.headers.get('access-control-allow-origin')})`);
  check('El preflight permite el header Authorization', /authorization/i.test(preflight.headers.get('access-control-allow-headers') ?? ''));
  const evilPreflight = await fetch(`${BASE}/auth/login`, { method: 'OPTIONS', headers: { Origin: 'https://sitio-malo.com', 'Access-Control-Request-Method': 'POST' } });
  check('Un origen no autorizado NO recibe permiso CORS', evilPreflight.headers.get('access-control-allow-origin') !== 'https://sitio-malo.com');

  // ───────────────────────── 1. Panel del admin ─────────────────────────
  section('1. Panel del administrador: resumen y flota');
  const summary = await api('GET', '/fleet/summary', ADMIN);
  check('GET /fleet/summary → { total, inService, idle, finished }', summary.status === 200 && ['total', 'inService', 'idle', 'finished'].every((k) => typeof summary.body[k] === 'number'), JSON.stringify(summary.body));
  const aSummary = await api('GET', '/assistance/summary', ADMIN);
  check('GET /assistance/summary → incidentes, alertas y reparaciones', aSummary.status === 200 && 'incidentsLast24h' in aSummary.body && 'repairsInProgress' in aSummary.body, JSON.stringify(aSummary.body));
  check('Un conductor no ve el resumen del admin → 403', (await api('GET', '/assistance/summary', DRIVER_A)).status === 403);
  const buses = (await api('GET', '/fleet/buses', ADMIN)).body;
  const tmx1 = buses.find((b) => b.plate === 'TMX-001');
  check('Los buses traen la ficha (modelo, año, operador, capacidad, ubicación) y su conductor',
    tmx1.model && tmx1.year && tmx1.operator && tmx1.capacity && tmx1.locationLabel && tmx1.driver === 'Carlos Pérez', `(${tmx1.model}, ${tmx1.capacity} pax)`);

  // ───────────────────────── 2. Registro de flota ─────────────────────────
  section('2. Registro de flota (alta y edición de buses)');
  const plate = `TLY-${uid}`;
  const created = await api('POST', '/fleet/buses', ADMIN, { plate: plate.toLowerCase(), route: 'F76', model: 'Marcopolo Viale BRS', year: 2022, operator: 'Consorcio Express S.A.S.', capacity: 160, locationLabel: 'Patio Fontibón' });
  check('El admin da de alta un bus (la placa se guarda en mayúsculas)', created.status === 201 && created.body.plate === plate, `(${created.body.plate})`);
  check('Placa repetida → 409', (await api('POST', '/fleet/buses', ADMIN, { plate, route: 'B23' })).status === 409);
  check('Placa inválida → 400', (await api('POST', '/fleet/buses', ADMIN, { plate: 'a b', route: 'B23' })).status === 400);
  const edited = await api('PATCH', `/fleet/buses/${created.body.id}`, ADMIN, { model: 'Biarticulado Volvo', capacity: 270 });
  check('El admin edita la ficha del bus', edited.status === 200 && edited.body.model === 'Biarticulado Volvo' && edited.body.capacity === 270 && edited.body.plate === plate);
  check('Un conductor no puede dar de alta buses → 403', (await api('POST', '/fleet/buses', DRIVER_A, { plate: 'ZZZ-999', route: 'X' })).status === 403);
  check('Un mecánico no puede editar buses → 403', (await api('PATCH', `/fleet/buses/${created.body.id}`, MECH_A, { model: 'X' })).status === 403);

  // ───────────────────────── 3. Usuarios ─────────────────────────
  section('3. Pantalla "Usuarios": crear, editar, desactivar, contraseñas');
  const users = await api('GET', '/users', ADMIN);
  check('El admin lista el personal (≥ 15 usuarios, sin contraseñas)', users.status === 200 && users.body.length >= 15 && !JSON.stringify(users.body).match(/passwordHash|\$2[aby]\$/));
  check('Un conductor no puede listar usuarios → 403', (await api('GET', '/users', DRIVER_A)).status === 403);

  const newId = `N${uid}`;
  const newUser = await api('POST', '/users', ADMIN, { employeeId: newId, name: 'Nuevo Conductor', role: 'DRIVER', password: 'Inicial2026' });
  check('El admin crea un usuario', newUser.status === 201 && newUser.body.active === true && !('passwordHash' in newUser.body));
  const dup = await api('POST', '/users', ADMIN, { employeeId: newId, name: 'Nombre Válido', role: 'DRIVER', password: 'Inicial2026' });
  check('Número de empleado repetido → 409 EMPLOYEE_ID_TAKEN', dup.status === 409 && dup.body.reason === 'EMPLOYEE_ID_TAKEN', `(${dup.status} ${dup.body.reason ?? dup.body.message})`);
  const weak = await api('POST', '/users', ADMIN, { employeeId: `W${uid}`, name: 'Nombre Válido', role: 'DRIVER', password: 'abc' });
  check('Contraseña débil → 400 WEAK_PASSWORD', weak.status === 400 && weak.body.reason === 'WEAK_PASSWORD', `(${weak.status} ${weak.body.reason ?? weak.body.message})`);
  check('Rol inventado → 400', (await api('POST', '/users', ADMIN, { employeeId: `R${uid}`, name: 'Nombre Válido', role: 'SUPERUSER', password: 'Inicial2026' })).status === 400);

  const firstLogin = await login(newId, 'Inicial2026');
  check('El usuario nuevo inicia sesión con su contraseña inicial', firstLogin.status === 200 && firstLogin.body.user.role === 'DRIVER');
  const newToken = firstLogin.body.accessToken;

  const promoted = await api('PATCH', `/users/${newUser.body.id}`, ADMIN, { role: 'MECHANICAL', name: 'Nuevo Mecánico' });
  check('El admin cambia su rol y nombre (conductor → mecánico)', promoted.status === 200 && promoted.body.role === 'MECHANICAL');
  const meAfter = await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${newToken}` } }).then((r) => r.json());
  check('El cambio de rol aplica de inmediato, aun con el token anterior', meAfter.role === 'MECHANICAL');

  await api('PATCH', `/users/${newUser.body.id}`, ADMIN, { active: false });
  check('Una cuenta desactivada ya no puede iniciar sesión → 401', (await login(newId, 'Inicial2026')).status === 401);
  check('…y su token anterior deja de valer → 401', (await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${newToken}` } })).status === 401);
  await api('PATCH', `/users/${newUser.body.id}`, ADMIN, { active: true });
  check('Al reactivarla recupera el acceso', (await login(newId, 'Inicial2026')).status === 200);

  const reset = await api('POST', `/users/${newUser.body.id}/reset-password`, ADMIN, { newPassword: 'Restablecida2027' });
  check('El admin restablece la contraseña → 204', reset.status === 204);
  check('La contraseña vieja ya no sirve y la nueva sí',
    (await login(newId, 'Inicial2026')).status === 401 && (await login(newId, 'Restablecida2027')).status === 200);

  const self = await api('GET', '/auth/me', ADMIN);
  check('Un admin no puede desactivarse a sí mismo → 409', (await api('PATCH', `/users/${self.body.id}`, ADMIN, { active: false })).status === 409);
  check('Un admin no puede quitarse el rol de administrador → 409', (await api('PATCH', `/users/${self.body.id}`, ADMIN, { role: 'DRIVER' })).status === 409);

  const mine = await login(newId, 'Restablecida2027');
  const meApi = (method, path, body) => fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mine.body.accessToken}` }, body: JSON.stringify(body) });
  check('Cambiar MI contraseña con la actual incorrecta → 401', (await meApi('POST', '/auth/change-password', { currentPassword: 'mala', newPassword: 'Tercera2028' })).status === 401);
  check('La nueva contraseña débil → 400', (await meApi('POST', '/auth/change-password', { currentPassword: 'Restablecida2027', newPassword: '123' })).status === 400);
  check('La nueva igual a la actual → 409', (await meApi('POST', '/auth/change-password', { currentPassword: 'Restablecida2027', newPassword: 'Restablecida2027' })).status === 409);
  check('Cambiar MI contraseña correctamente → 204', (await meApi('POST', '/auth/change-password', { currentPassword: 'Restablecida2027', newPassword: 'Tercera2028' })).status === 204);
  check('Inicia sesión con la contraseña nueva', (await login(newId, 'Tercera2028')).status === 200);

  // ───────────────────────── 4. Asignar conductor a un bus ─────────────────────────
  section('4. Asignación de conductor a un bus');
  const assignable = await api('POST', '/users', ADMIN, { employeeId: `D${uid}`, name: 'Conductor Libre', role: 'DRIVER', password: 'Inicial2026' });
  const assigned = await api('PATCH', `/fleet/buses/${created.body.id}/driver`, ADMIN, { driverId: assignable.body.id });
  check('El admin asigna un conductor al bus nuevo', assigned.status === 200 && assigned.body.driverId === assignable.body.id && assigned.body.driver === 'Conductor Libre');
  const home = await fetch(`${BASE}/fleet/home/operativo`, { headers: { Authorization: `Bearer ${await tokenFor(BASE, `D${uid}`, 'Inicial2026')}` } }).then((r) => r.json());
  check('El conductor ve ese bus en su home', home.plate === plate);
  check('Un conductor no puede tener dos buses → 409', (await api('PATCH', `/fleet/buses/${tmx1.id}/driver`, ADMIN, { driverId: assignable.body.id })).status === 409);
  check('Asignar un mecánico como conductor → 400', (await api('PATCH', `/fleet/buses/${created.body.id}/driver`, ADMIN, { driverId: (await api('GET', '/auth/me', MECH_A)).body.id })).status === 400);
  check('Quitar el conductor (null)', (await api('PATCH', `/fleet/buses/${created.body.id}/driver`, ADMIN, { driverId: null })).body.driverId === null);

  // ───────────────────────── 5. Inspección previa al viaje (conductor) ─────────────────────────
  section('5. Inspección previa al viaje con fotos (modal "Inspección")');
  const myBus = (await api('GET', '/fleet/home/operativo', DRIVER_B)).body;
  const photo1 = await uploadPhoto(DRIVER_B);
  const photo2 = await uploadPhoto(DRIVER_B);
  check('El conductor sube 2 fotos del bus → URLs de /uploads', photo1.status === 201 && /^\/uploads\//.test(photo1.body.url) && photo2.status === 201);
  const shown = await fetch(`${BASE}${photo1.body.url}`, { headers: { Origin: ORIGIN } });
  check('La foto se muestra con <img src> y el navegador puede leerla (CORS)', shown.status === 200 && (shown.headers.get('content-type') ?? '').startsWith('image/') && shown.headers.get('access-control-allow-origin') === ORIGIN);
  check('Un archivo que no es imagen no se sube → 400', (await uploadPhoto(DRIVER_B, Buffer.from('<?php evil(); ?>'), 'image/jpeg')).status === 400);

  const insp = await api('POST', '/inspections', DRIVER_B, { busId: myBus.busId, note: 'Todo en orden para salir', comment: 'Llanta delantera con desgaste leve', photos: [photo1.body.url, photo2.body.url] });
  check('Registra la inspección de su bus (nota, comentario, 2 fotos)', insp.status === 201 && insp.body.inspectorName === 'Laura Gómez' && insp.body.inspectorRole === 'DRIVER' && insp.body.photos.length === 2, `(${insp.body.inspectorName})`);
  check('No puede registrar la inspección del bus de otro conductor → 403', (await api('POST', '/inspections', DRIVER_B, { busId: tmx1.id, note: 'x' })).status === 403);
  check('Una foto de un sitio externo se rechaza → 400', (await api('POST', '/inspections', DRIVER_B, { busId: myBus.busId, note: 'x', photos: ['https://malo.com/a.jpg'] })).status === 400);
  check('Sin nota → 400', (await api('POST', '/inspections', DRIVER_B, { busId: myBus.busId, note: '   ' })).status === 400);

  const latest = await api('GET', `/inspections/buses/${myBus.busId}/latest`, ADMIN);
  check('El admin ve la inspección más reciente al abrir el bus (BusReportModal)', latest.status === 200 && latest.body.note === 'Todo en orden para salir' && latest.body.photos.length === 2);
  check('El mecánico también puede consultarla', (await api('GET', `/inspections/buses/${myBus.busId}/latest`, MECH_A)).status === 200);
  check('Otro conductor no puede ver la inspección de ese bus → 403', (await api('GET', `/inspections/buses/${myBus.busId}/latest`, DRIVER_A)).status === 403);
  check('Un bus sin inspecciones → 404 (el front muestra su informe de ejemplo)', (await api('GET', `/inspections/buses/${created.body.id}/latest`, ADMIN)).status === 404);
  const history = await api('GET', `/inspections?busId=${myBus.busId}&inspector=laura`, ADMIN);
  check('El historial filtra por bus y por conductor', history.status === 200 && history.body.length >= 1 && history.body.every((i) => i.busId === myBus.busId));
  check('Un conductor no puede ver el historial general → 403', (await api('GET', '/inspections', DRIVER_B)).status === 403);

  // ───────────────────────── 6. Iniciar viaje y ubicación ─────────────────────────
  section('6. Viaje del conductor y mapa');
  check('Inicia el viaje', (await api('PATCH', `/fleet/buses/${myBus.busId}/start-trip`, DRIVER_B)).status === 200);
  check('Envía su ubicación', (await api('PATCH', `/fleet/buses/${myBus.busId}/position`, DRIVER_B, { latitude: 4.65, longitude: -74.1 })).status === 200);
  const inService = (await api('GET', '/fleet/buses?status=IN_SERVICE', ADMIN)).body;
  const live = inService.find((b) => b.id === myBus.busId);
  check('El admin ve el bus en servicio con su posición (mapa)', live?.latitude === 4.65);
  check('El viaje trae la hora de salida ("salió 14:32")', !!live?.tripStartedAt && Math.abs(Date.now() - new Date(live.tripStartedAt)) < 60_000, `(${live?.tripStartedAt})`);

  // ───────────────────────── 7. Ayuda entre conductores ─────────────────────────
  section('7. Pantalla "Ayuda": el conductor reporta un problema y otros conductores responden');
  const incident = await api('POST', '/assistance/incidents', DRIVER_A, { busId: (await api('GET', '/fleet/home/operativo', DRIVER_A)).body.busId, type: 'Falla mecánica', description: 'Se apagó en plena Troncal Caracas' });
  check('El conductor reporta el problema (motivo + detalle)', incident.status === 201 && incident.body.reportedByName === 'Carlos Pérez', `(${incident.body.reportedByName})`);
  const incidents = await api('GET', '/assistance/incidents', ADMIN);
  check('El admin lo ve con quién lo reportó', incidents.body.find((i) => i.id === incident.body.id)?.reportedByName === 'Carlos Pérez');
  const support = await api('POST', `/assistance/incidents/${incident.body.id}/support-call`, ADMIN, { slots: 1, rewardPoints: 30 });
  check('El admin lanza la solicitud de ayuda (1 conductor)', support.status === 201);

  const helpList = (await api('GET', '/assistance/calls?status=OPEN', DRIVER_C)).body;
  const help = helpList.find((c) => c.id === support.body.id);
  check('Otro conductor la ve con motivo, detalle, quién reportó y placa/troncal del bus',
    help?.incident?.type === 'Falla mecánica' && help.incident.description.includes('Troncal Caracas') && help.incident.reportedByName === 'Carlos Pérez' && help.bus?.plate === 'TMX-001' && help.bus?.route === 'Troncal Caracas',
    `(${help?.bus?.plate} · ${help?.bus?.route})`);
  const accepts = await Promise.all([DRIVER_B, DRIVER_C].map((d) => api('POST', `/assistance/calls/${support.body.id}/accept`, d)));
  check('Dos conductores aceptan a la vez: gana UNO ("Aceptada por …")', accepts.filter((r) => r.status === 201).length === 1 && accepts.filter((r) => r.status === 409).length === 1);
  const after = (await api('GET', '/assistance/calls', DRIVER_A)).body;
  check('El que reportó ve la solicitud, pero no puede aceptarla → 403', (await api('POST', `/assistance/calls/${support.body.id}/accept`, DRIVER_A)).status === 403);

  // ───────────────────────── 8. Reparación con informe del mecánico ─────────────────────────
  section('8. Pantallas del mecánico: solicitudes, informe (borrador y final) e historial');
  const fault = await api('POST', '/assistance/bus-faults', DRIVER_A, { busId: (await api('GET', '/fleet/home/operativo', DRIVER_A)).body.busId, description: 'Falla de frenos en Calle 72' });
  check('Se genera la solicitud de reparación', fault.status === 201);
  const requests = (await api('GET', '/assistance/calls?status=OPEN', MECH_A)).body;
  const request = requests.find((c) => c.id === fault.body.call.id);
  check('El mecánico la ve con placa, troncal, ubicación y el problema',
    request?.kind === 'REPAIR' && request.bus?.plate === 'TMX-001' && request.bus.route && request.bus.locationLabel && request.description === 'Falla de frenos en Calle 72');
  check('Un conductor no ve las solicitudes de reparación', !(await api('GET', '/assistance/calls?status=OPEN', DRIVER_B)).body.some((c) => c.id === fault.body.call.id));
  const race = await Promise.all([MECH_A, MECH_B].map((m) => api('POST', `/assistance/calls/${fault.body.call.id}/accept`, m)));
  check('Dos mecánicos aceptan a la vez: gana UNO', race.filter((r) => r.status === 201).length === 1);
  const owner = race[0].status === 201 ? MECH_A : MECH_B;
  const other = owner === MECH_A ? MECH_B : MECH_A;
  const callId = fault.body.call.id;

  const bus1 = await uploadPhoto(owner);
  const part1 = await uploadPhoto(owner);
  const draft = await api('PUT', `/assistance/calls/${callId}/repair-report`, owner, { damages: 'Pastillas gastadas', expenses: [{ concepto: '', valor: 0 }], busPhotos: [bus1.body.url] });
  check('Guarda un borrador del informe (sin cerrar el servicio)', draft.status === 200 && draft.body.completed === false && draft.body.report.completedAt === null && draft.body.report.expenses.length === 0);
  check('El otro mecánico no puede escribir ese informe → 403', (await api('PUT', `/assistance/calls/${callId}/repair-report`, other, { damages: 'x' })).status === 403);
  check('Una foto externa en el informe → 400', (await api('PUT', `/assistance/calls/${callId}/repair-report`, owner, { damages: 'x', busPhotos: ['https://malo.com/x.jpg'] })).status === 400);
  check('Un gasto con valor negativo → 400', (await api('PUT', `/assistance/calls/${callId}/repair-report`, owner, { damages: 'x', expenses: [{ concepto: 'a', valor: -1 }] })).status === 400);
  check('Finalizar sin describir los daños → 400', (await api('PUT', `/assistance/calls/${callId}/repair-report`, owner, { damages: '', finalize: true })).status === 400);
  const pointsBefore = (await api('GET', '/assistance/me', owner)).body.points;

  const final = await api('PUT', `/assistance/calls/${callId}/repair-report`, owner, {
    damages: 'Pastillas delanteras gastadas y disco rayado', replacedParts: 'Pastillas y disco delantero',
    expenses: [{ concepto: 'Repuestos', valor: 280000 }, { concepto: 'Mano de obra', valor: 90000 }],
    busPhotos: [bus1.body.url], partPhotos: [part1.body.url], finalize: true,
  });
  check('"Finalizar servicio": informe definitivo y reparación cerrada', final.status === 200 && final.body.completed === true && final.body.report.completedAt, `(gastos: ${final.body.report?.expenses.reduce((s, g) => s + g.valor, 0)})`);
  check('El mecánico cobra su bono de 50 puntos', (await api('GET', '/assistance/me', owner)).body.points === pointsBefore + 50);
  check('Modificar un informe finalizado → 409', (await api('PUT', `/assistance/calls/${callId}/repair-report`, owner, { damages: 'cambio' })).status === 409);
  const finishedCall = (await api('GET', '/assistance/calls?status=COMPLETED', ADMIN)).body.find((c) => c.id === callId);
  check('La solicitud queda "completada"', finishedCall?.status === 'COMPLETED');

  const myReports = await api('GET', '/assistance/repair-reports', owner);
  check('"Mis reparaciones": el mecánico ve su informe con los datos del bus', myReports.status === 200 && myReports.body.some((r) => r.callId === callId && r.bus?.plate === 'TMX-001' && r.completedAt));
  check('El otro mecánico no ve ese informe en su historial', !(await api('GET', '/assistance/repair-reports', other)).body.some((r) => r.callId === callId));
  check('"Mantenimiento": el admin ve todos los informes', (await api('GET', '/assistance/repair-reports', ADMIN)).body.some((r) => r.callId === callId));
  check('El admin lee el informe completo (daños, piezas, gastos y fotos)', await api('GET', `/assistance/calls/${callId}/repair-report`, ADMIN).then((r) => r.status === 200 && r.body.replacedParts === 'Pastillas y disco delantero' && r.body.partPhotos.length === 1));
  check('El otro mecánico no puede leer ese informe → 403', (await api('GET', `/assistance/calls/${callId}/repair-report`, other)).status === 403);

  // ───────────────────────── 9. Cierre del viaje ─────────────────────────
  check('\n   El conductor finaliza su viaje', (await api('PATCH', `/fleet/buses/${myBus.busId}/finish-trip`, DRIVER_B)).status === 200);

  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} verificación(es) fallaron`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
