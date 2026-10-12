/* eslint-disable */
/**
 * E2E contra un back real (Postgres + Redis) de lo que cuenta la rama de grúas, rutas alternativas y evidencia,
 * y de la regla "una alerta que otro ya tomó se quita de la lista de los demás":
 *
 *  1. Grúas: asignar, rechazar grúa/cuadrilla ocupada (aunque la escriban distinto), CARRERA de dos admins por la
 *     misma grúa, terminar el servicio y reutilizarla.
 *  2. Eliminar un incidente NO puede quitar una grúa en servicio ni una ruta que un conductor tiene asignada/aceptada.
 *  3. Rutas alternativas: geometría inválida, asignar solo a conductores reales, aceptar.
 *  4. Evidencia: solo imágenes subidas a este back.
 *  5. "Se quita": al llenarse los cupos la alerta desaparece para los demás conductores (y reaparece si se cancela).
 *  6. Tiempo real: el evento `call.closed` llega a los conductores cuando se llenan los cupos.
 *
 *   BASE_URL=http://localhost:3300 SEED_PASSWORD=... node scripts/load-tests/tow-flows.js
 */
const { makeApi, tokenFor, listen } = require('./lib');

const BASE = process.env.BASE_URL || 'http://localhost:3300';
const api = makeApi(BASE);
const RUN = Date.now().toString(36).toUpperCase();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]), Buffer.alloc(64)]);
async function uploadImage(employeeId) {
  const form = new FormData();
  form.append('photo', new Blob([JPEG], { type: 'image/jpeg' }), 'foto.jpg');
  const r = await fetch(`${BASE}/files/images`, { method: 'POST', headers: { Authorization: `Bearer ${await tokenFor(BASE, employeeId)}` }, body: form });
  return r.json();
}

async function main() {
  const busOf = async (id) => (await api('GET', '/fleet/home/operativo', id)).body.busId;
  const bus1 = await busOf('2001');
  const newIncident = async (type = 'ACCIDENTE') => (await api('POST', '/assistance/incidents', '2001', { busId: bus1, type, description: `e2e ${RUN}` })).body;
  const users = (await api('GET', '/users', '1001')).body;
  const idOf = (employeeId) => users.find((u) => u.employeeId === employeeId).id;

  // ───────────────────────── 1. GRÚAS ─────────────────────────
  console.log('\n— 1. Grúas');
  const [iA, iB, iC] = [await newIncident(), await newIncident(), await newIncident()];
  const truck = `G-${RUN}`, crew = `C-${RUN}`;

  const a1 = await api('POST', `/assistance/blockages/${iA.id}/tow`, '1001', { towTruck: ` ${truck.toLowerCase()} `, crew: crew.toLowerCase() });
  check('el admin asigna grúa y cuadrilla (nombres normalizados)', a1.status === 201 && a1.body.towTruck === truck && a1.body.crew === crew, JSON.stringify([a1.status, a1.body.towTruck, a1.body.crew]));

  const a2 = await api('POST', `/assistance/blockages/${iB.id}/tow`, '1002', { towTruck: truck, crew: `C-OTRA-${RUN}` });
  check('la misma grúa en otro incidente → 409 TOW_TRUCK_BUSY', a2.status === 409 && a2.body.reason === 'TOW_TRUCK_BUSY', JSON.stringify([a2.status, a2.body.reason]));
  const a2b = await api('POST', `/assistance/blockages/${iB.id}/tow`, '1002', { towTruck: ` ${truck.toLowerCase()}  `, crew: `C-OTRA-${RUN}` });
  check('escrita distinto (minúsculas y espacios) también → 409', a2b.status === 409, `status ${a2b.status}`);
  const a3 = await api('POST', `/assistance/blockages/${iB.id}/tow`, '1002', { towTruck: `G-OTRA-${RUN}`, crew: crew });
  check('la misma cuadrilla → 409 CREW_BUSY', a3.status === 409 && a3.body.reason === 'CREW_BUSY', JSON.stringify([a3.status, a3.body.reason]));
  const a4 = await api('POST', `/assistance/blockages/${iB.id}/tow`, '2001', { towTruck: `G-X-${RUN}`, crew: `C-X-${RUN}` });
  check('un conductor NO puede asignar grúas (403)', a4.status === 403, `status ${a4.status}`);
  const a5 = await api('POST', `/assistance/blockages/00000000-0000-4000-8000-000000000000/tow`, '1001', { towTruck: `G-Y-${RUN}`, crew: `C-Y-${RUN}` });
  check('incidente inexistente → 404', a5.status === 404, `status ${a5.status}`);
  const a6 = await api('POST', `/assistance/blockages/${iB.id}/tow`, '1001', { towTruck: '   ', crew: 'C-1' });
  check('grúa vacía → 400', a6.status === 400, `status ${a6.status}`);

  // CARRERA: 12 asignaciones simultáneas de la MISMA grúa a 12 incidentes (dos admins)
  const race = [];
  for (let i = 0; i < 12; i++) race.push(await newIncident());
  const raceTruck = `G-RACE-${RUN}`;
  const results = await Promise.all(race.map((inc, i) =>
    api('POST', `/assistance/blockages/${inc.id}/tow`, i % 2 ? '1002' : '1001', { towTruck: raceTruck, crew: `C-RACE-${RUN}-${i}` })));
  const winners = results.filter((r) => r.status === 201);
  const losers = results.filter((r) => r.status === 409 && r.body.reason === 'TOW_TRUCK_BUSY');
  check('carrera: 12 admins por la misma grúa → exactamente 1 gana', winners.length === 1 && losers.length === 11, `ganan ${winners.length}, 409 ${losers.length}`);

  const reports = (await api('GET', `/assistance/tow-reports?towTruck=${encodeURIComponent(raceTruck)}`, '1001')).body;
  check('el reporte de grúas muestra una sola asignación activa de esa grúa', Array.isArray(reports) && reports.filter((r) => r.status === 'ASSIGNED').length === 1, `filas ${Array.isArray(reports) ? reports.length : '?'}`);

  // terminar el servicio libera la grúa
  const done = await api('POST', `/assistance/tow-assignments/${winners[0].body.id}/complete`, '1001');
  check('terminar el servicio de grúa', done.status === 201 && done.body.status === 'COMPLETED', `status ${done.status}`);
  const again = await api('POST', `/assistance/tow-assignments/${winners[0].body.id}/complete`, '1001');
  check('terminarlo otra vez → 409', again.status === 409, `status ${again.status}`);
  const reuse = await api('POST', `/assistance/blockages/${race[3].id}/tow`, '1001', { towTruck: raceTruck, crew: `C-RACE-${RUN}-reuse` });
  check('la grúa liberada se puede volver a asignar', reuse.status === 201, `status ${reuse.status}`);
  await api('POST', `/assistance/tow-assignments/${reuse.body.id}/complete`, '1001');

  // ───────────────────────── 2. ELIMINAR INCIDENTE vs. GRÚA / RUTA ─────────────────────────
  console.log('\n— 2. Eliminar un incidente con grúa o ruta en curso');
  const delBusyTow = await api('DELETE', `/assistance/incidents/${iA.id}`, '1001');
  check('incidente con grúa EN SERVICIO → 409 (no se pierde la asignación)', delBusyTow.status === 409, `status ${delBusyTow.status}`);
  const stillBusy = (await api('GET', `/assistance/tow-reports?incidentId=${iA.id}`, '1001')).body;
  check('la grúa sigue asignada tras el intento', stillBusy.length === 1 && stillBusy[0].status === 'ASSIGNED');
  const blockedTruck = await api('POST', `/assistance/blockages/${iC.id}/tow`, '1001', { towTruck: truck, crew: `C-Z-${RUN}` });
  check('y esa grúa sigue ocupada para otros servicios', blockedTruck.status === 409);
  await api('POST', `/assistance/tow-assignments/${a1.body.id}/complete`, '1001');
  const delOk = await api('DELETE', `/assistance/incidents/${iA.id}`, '1001');
  check('con el servicio de grúa terminado el incidente SÍ se puede eliminar', delOk.status === 200, `status ${delOk.status}`);

  // ───────────────────────── 3. RUTAS ALTERNATIVAS ─────────────────────────
  console.log('\n— 3. Rutas alternativas');
  const iR = await newIncident('BLOQUEO');
  const bad = [
    ['una sola punta', [[4.6, -74.1]]],
    ['puntos con texto', [['a', 'b'], ['c', 'd']]],
    ['latitud fuera de rango', [[200, -74.1], [4.7, -74.2]]],
    ['punto mal formado', [[4.6, -74.1, 5], [4.7, -74.2]]],
  ];
  for (const [name, geometry] of bad) {
    const r = await api('POST', `/assistance/incidents/${iR.id}/routes`, '1001', { name: 'x', geometry });
    check(`geometría inválida (${name}) → 400`, r.status === 400, `status ${r.status}`);
  }
  const route = await api('POST', `/assistance/incidents/${iR.id}/routes`, '1001', { name: `Desvío ${RUN}`, geometry: [[4.6, -74.1], [4.61, -74.11], [4.62, -74.12]] });
  check('ruta válida', route.status === 201, `status ${route.status}`);
  const toMech = await api('POST', `/assistance/routes/${route.body.id}/assign`, '1001', { driverId: idOf('3001') });
  check('asignar la ruta a un MECÁNICO → 400', toMech.status === 400, `status ${toMech.status}`);
  const toGhost = await api('POST', `/assistance/routes/${route.body.id}/assign`, '1001', { driverId: '00000000-0000-4000-8000-000000000000' });
  check('asignar la ruta a un id inventado → 400', toGhost.status === 400, `status ${toGhost.status}`);

  const delWithProposed = await (async () => {
    const iP = await newIncident('BLOQUEO');
    await api('POST', `/assistance/incidents/${iP.id}/routes`, '1001', { name: 'solo propuesta', geometry: [[4.6, -74.1], [4.7, -74.2]] });
    return api('DELETE', `/assistance/incidents/${iP.id}`, '1001');
  })();
  check('una ruta solo PROPUESTA no impide eliminar el incidente', delWithProposed.status === 200, `status ${delWithProposed.status}`);

  const drv = '2002';
  const assign = await api('POST', `/assistance/routes/${route.body.id}/assign`, '1001', { driverId: idOf(drv) });
  check('asignar la ruta a un conductor', assign.status === 201 && assign.body.status === 'ASSIGNED', `status ${assign.status}`);
  const delAssigned = await api('DELETE', `/assistance/incidents/${iR.id}`, '1001');
  check('incidente con ruta ASIGNADA a un conductor → 409', delAssigned.status === 409, `status ${delAssigned.status}`);
  const wrongDriver = await api('POST', `/assistance/routes/${route.body.id}/accept`, '2003');
  check('otro conductor no puede aceptar una ruta que no es suya → 409', wrongDriver.status === 409, `status ${wrongDriver.status}`);
  const mine = (await api('GET', '/assistance/routes/assigned/me', drv)).body;
  check('el conductor ve su ruta asignada', Array.isArray(mine) && mine.some((r) => r.id === route.body.id));
  const accepted = await api('POST', `/assistance/routes/${route.body.id}/accept`, drv);
  check('el conductor acepta la ruta', accepted.status === 201 && accepted.body.status === 'ACCEPTED', `status ${accepted.status}`);
  const delAccepted = await api('DELETE', `/assistance/incidents/${iR.id}`, '1001');
  check('incidente con ruta ACEPTADA → 409', delAccepted.status === 409, `status ${delAccepted.status}`);

  // ───────────────────────── 4. EVIDENCIA ─────────────────────────
  console.log('\n— 4. Evidencia fotográfica');
  const iE = await newIncident();
  const ext = await api('POST', `/assistance/incidents/${iE.id}/evidence`, '2001', { url: 'https://sitio-externo.com/tracking.gif' });
  check('evidencia con una URL externa → 400', ext.status === 400, `status ${ext.status}`);
  const trav = await api('POST', `/assistance/incidents/${iE.id}/evidence`, '2001', { url: '/uploads/../../etc/passwd' });
  check('evidencia con una ruta arbitraria → 400', trav.status === 400, `status ${trav.status}`);
  const up = await uploadImage('2001');
  const evOk = await api('POST', `/assistance/incidents/${iE.id}/evidence`, '2001', { url: up.url, caption: 'foto' });
  check('evidencia con una imagen subida al back', evOk.status === 201, `status ${evOk.status}`);
  const list = (await api('GET', `/assistance/incidents/${iE.id}/evidence`, '1001')).body;
  check('el admin ve la evidencia', list.length === 1 && list[0].url === up.url);

  // ───────────────────────── 5 y 6. "SE QUITA" + TIEMPO REAL ─────────────────────────
  console.log('\n— 5/6. Una alerta tomada se quita para los demás (y llega el evento call.closed)');
  const d3 = await listen(BASE, '2003');
  const d4 = await listen(BASE, '2004');
  const iS = await newIncident('ACCIDENTE');
  const sc = (await api('POST', `/assistance/incidents/${iS.id}/support-call`, '1001', { slots: 1, rewardPoints: 10 })).body;
  const seen = async (id) => ((await api('GET', '/assistance/calls', id)).body || []).some((c) => c.id === sc.id);
  await sleep(600);
  check('abierta: la ven los otros conductores (2003 y 2004)', (await seen('2003')) && (await seen('2004')));
  check('a 2003 le llegó el evento call.opened', d3.events.some((e) => e.type === 'call.opened' && e.payload.callId === sc.id));
  check('el evento call.opened ya trae el incidentId', d3.events.some((e) => e.type === 'call.opened' && e.payload.incidentId === iS.id));

  const take = await api('POST', `/assistance/calls/${sc.id}/accept`, '2003');
  check('2003 la toma (cupo único)', take.status === 201 || take.status === 200, `status ${take.status}`);
  await sleep(800);
  check('a 2004 le llega call.closed (cupos completos)', d4.events.some((e) => e.type === 'call.closed' && e.payload.callId === sc.id));
  check('"se quita": 2004 YA NO la ve', !(await seen('2004')));
  check('quien la tomó (2003) la conserva', await seen('2003'));
  check('el conductor del bus (2001) la ve (le llegó ayuda)', await seen('2001'));
  check('el admin la ve', await seen('1001'));
  const late = await api('POST', `/assistance/calls/${sc.id}/accept`, '2004');
  check('si 2004 intenta tomarla tarde → 409', late.status === 409, `status ${late.status}`);

  const claim = (await api('GET', '/assistance/calls', '1001')).body.find((c) => c.id === sc.id).claims[0];
  await api('POST', `/assistance/calls/${sc.id}/claims/${claim.id}/cancel`, '1001');
  await sleep(300);
  check('si el admin cancela la aceptación, la alerta vuelve a la lista de 2004', await seen('2004'));

  d3.socket.disconnect(); d4.socket.disconnect();

  // limpieza: terminar lo que quedó en servicio para no dejar grúas ocupadas
  const active = (await api('GET', '/assistance/tow-reports?status=ASSIGNED', '1001')).body || [];
  for (const t of active.filter((x) => x.towTruck.includes(RUN))) await api('POST', `/assistance/tow-assignments/${t.id}/complete`, '1001');

  console.log(failed === 0 ? '\nTODO OK' : `\n${failed} FALLOS`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
