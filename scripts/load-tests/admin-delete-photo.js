/* eslint-disable */
/**
 * E2E contra un back real (Postgres + Redis):
 *  1. Foto del bus: el admin la sube, la cambia y la quita; se rechazan URLs que no son de este back.
 *  2. Eliminar incidentes: sin atender → se borra; con una aceptación → 409 y nada cambia; inexistente → 404.
 *  3. Carrera: un conductor acepta la alerta justo cuando el admin elimina el incidente. Nunca debe quedar una
 *     aceptación huérfana: o gana el borrado (y el conductor recibe error), o gana la aceptación (y el borrado da 409).
 *
 *   BASE_URL=http://localhost:3300 SEED_PASSWORD=... node scripts/load-tests/admin-delete-photo.js
 */
const BASE = process.env.BASE_URL || 'http://localhost:3300';
const PASSWORD = process.env.SEED_PASSWORD || 'Sitp2026!';
const ROUNDS = Number(process.env.ROUNDS || 25);

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
};

async function call(method, path, token, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* sin cuerpo */ }
  return { status: res.status, data };
}
const login = async (employeeId) => (await call('POST', '/auth/login', null, { employeeId, password: PASSWORD })).data.accessToken;

// JPEG mínimo válido por su firma (el back valida el contenido, no el nombre)
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]), Buffer.alloc(64)]);
async function upload(token) {
  const form = new FormData();
  form.append('photo', new Blob([JPEG], { type: 'image/jpeg' }), 'bus.jpg');
  return call('POST', '/files/images', token, form);
}

(async () => {
  const admin = await login('1001');
  const drivers = await Promise.all(['2001', '2002', '2003', '2004', '2005'].map(login));
  const buses = (await call('GET', '/fleet/buses', admin)).data;
  const busId = buses[0].id;

  // ── 1. Foto del bus ──
  const up1 = await upload(admin);
  check('subir imagen (admin)', up1.status === 201 || up1.status === 200, JSON.stringify(up1.data));
  const set = await call('PATCH', `/fleet/buses/${busId}`, admin, { photoUrl: up1.data.url });
  check('asignar la foto al bus', set.status === 200 && set.data.photoUrl === up1.data.url);
  const listed = (await call('GET', '/fleet/buses', admin)).data.find((b) => b.id === busId);
  check('el listado de buses trae photoUrl', listed.photoUrl === up1.data.url);

  const up2 = await upload(admin);
  const changed = await call('PATCH', `/fleet/buses/${busId}`, admin, { photoUrl: up2.data.url });
  check('cambiar la foto', changed.status === 200 && changed.data.photoUrl === up2.data.url);
  const other = await call('PATCH', `/fleet/buses/${busId}`, admin, { model: 'Volvo' });
  check('editar otro dato no borra la foto', other.data.photoUrl === up2.data.url);

  for (const bad of ['https://externo.com/x.jpg', '/uploads/../../etc/passwd', 'javascript:alert(1)']) {
    const r = await call('PATCH', `/fleet/buses/${busId}`, admin, { photoUrl: bad });
    check(`rechaza ${bad}`, r.status === 400, `status ${r.status}`);
  }
  const asDriver = await call('PATCH', `/fleet/buses/${busId}`, drivers[0], { photoUrl: up2.data.url });
  check('un conductor NO puede cambiar la foto del bus (403)', asDriver.status === 403, `status ${asDriver.status}`);

  const removed = await call('PATCH', `/fleet/buses/${busId}`, admin, { photoUrl: null });
  check('quitar la foto (null)', removed.status === 200 && removed.data.photoUrl === null);

  // ── 2. Eliminar incidentes ──
  const driverBus = async (token) => (await call('GET', '/fleet/home/operativo', token)).data.busId;
  const myBus = await driverBus(drivers[0]);
  const inc = await call('POST', '/assistance/incidents', drivers[0], { busId: myBus, type: 'ACCIDENTE', description: 'prueba' });
  check('el conductor reporta un incidente', inc.status === 201, `status ${inc.status}`);

  const noAdmin = await call('DELETE', `/assistance/incidents/${inc.data.id}`, drivers[0]);
  check('un conductor NO puede eliminar incidentes (403)', noAdmin.status === 403, `status ${noAdmin.status}`);

  const del = await call('DELETE', `/assistance/incidents/${inc.data.id}`, admin);
  check('el admin elimina un incidente sin atender', del.status === 200 && del.data.deleted === true, JSON.stringify(del.data));
  const again = await call('DELETE', `/assistance/incidents/${inc.data.id}`, admin);
  check('eliminarlo de nuevo → 404', again.status === 404, `status ${again.status}`);
  const list = (await call('GET', '/assistance/incidents', admin)).data;
  check('ya no aparece en la lista', !list.some((i) => i.id === inc.data.id));

  // incidente con alerta abierta sin aceptar → se borran ambos
  const inc2 = (await call('POST', '/assistance/incidents', drivers[0], { busId: myBus, type: 'FALLA' })).data;
  const call2 = (await call('POST', `/assistance/incidents/${inc2.id}/support-call`, admin, { slots: 2, rewardPoints: 10 })).data;
  const del2 = await call('DELETE', `/assistance/incidents/${inc2.id}`, admin);
  check('con alerta abierta sin aceptar: se borra todo', del2.status === 200 && del2.data.removedCalls === 1, JSON.stringify(del2.data));
  const calls = (await call('GET', '/assistance/calls', admin)).data;
  check('la alerta también desapareció', !calls.some((c) => c.id === call2.id));

  // incidente con una aceptación → 409 y no se toca nada
  const inc3 = (await call('POST', '/assistance/incidents', drivers[0], { busId: myBus, type: 'FALLA' })).data;
  const call3 = (await call('POST', `/assistance/incidents/${inc3.id}/support-call`, admin, { slots: 2, rewardPoints: 10 })).data;
  const acc = await call('POST', `/assistance/calls/${call3.id}/accept`, drivers[1]);
  check('un compañero acepta la alerta', acc.status === 201 || acc.status === 200, `status ${acc.status}`);
  const del3 = await call('DELETE', `/assistance/incidents/${inc3.id}`, admin);
  check('con una aceptación → 409', del3.status === 409, `status ${del3.status} ${del3.data && del3.data.message}`);
  const still = (await call('GET', '/assistance/incidents', admin)).data.some((i) => i.id === inc3.id);
  check('el incidente sigue existiendo', still);

  // solicitud de reparación enviada desde el incidente: se borra con él
  const mech = await login('3001');
  const incR = (await call('POST', '/assistance/incidents', drivers[0], { busId: myBus, type: 'FALLA' })).data;
  const fault = await call('POST', '/assistance/bus-faults', admin, { busId: myBus, incidentId: incR.id, description: 'motor' });
  check('el admin envía la solicitud al mecánico desde el incidente', fault.status === 201 && fault.data.call.incidentId === incR.id, JSON.stringify(fault.data.call && fault.data.call.incidentId));
  const delR = await call('DELETE', `/assistance/incidents/${incR.id}`, admin);
  check('al eliminar el incidente se elimina la solicitud al mecánico', delR.status === 200 && delR.data.removedCalls === 1, JSON.stringify(delR.data));
  const repairsLeft = (await call('GET', '/assistance/calls', mech)).data.filter((c) => c.id === fault.data.call.id);
  check('el mecánico ya no la ve', repairsLeft.length === 0);

  // si el mecánico ya la aceptó: 409 y no se borra nada
  const incR2 = (await call('POST', '/assistance/incidents', drivers[0], { busId: myBus, type: 'FALLA' })).data;
  const fault2 = (await call('POST', '/assistance/bus-faults', admin, { busId: myBus, incidentId: incR2.id })).data;
  const accR = await call('POST', `/assistance/calls/${fault2.call.id}/accept`, mech);
  check('el mecánico acepta la reparación', accR.status === 200 || accR.status === 201, `status ${accR.status}`);
  const delR2 = await call('DELETE', `/assistance/incidents/${incR2.id}`, admin);
  check('con el mecánico trabajando → 409', delR2.status === 409, `status ${delR2.status}`);
  const stillRepair = (await call('GET', '/assistance/calls', mech)).data.some((c) => c.id === fault2.call.id);
  check('la reparación en curso sigue ahí', stillRepair);
  // limpieza: el admin cancela la aceptación y elimina
  await call('POST', `/assistance/calls/${fault2.call.id}/complete`, admin);

  const badInc = await call('POST', '/assistance/bus-faults', admin, { busId: myBus, incidentId: '00000000-0000-4000-8000-000000000000' });
  check('solicitud con un incidente inexistente → 404', badInc.status === 404, `status ${badInc.status}`);

  // ── 3. Carrera aceptar vs eliminar ──
  let deletedWins = 0, acceptWins = 0, orphan = 0, unexpected = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const inc = (await call('POST', '/assistance/incidents', drivers[0], { busId: myBus, type: 'FALLA' })).data;
    const sc = (await call('POST', `/assistance/incidents/${inc.id}/support-call`, admin, { slots: 3, rewardPoints: 5 })).data;
    const [d, a] = await Promise.all([
      call('DELETE', `/assistance/incidents/${inc.id}`, admin),
      call('POST', `/assistance/calls/${sc.id}/accept`, drivers[2 + (i % 3)]),
    ]);
    const accepted = a.status === 200 || a.status === 201;
    if (d.status === 200 && !accepted) deletedWins++;
    else if (d.status === 409 && accepted) acceptWins++;
    else { unexpected++; console.log('  caso raro', i, 'delete', d.status, 'accept', a.status); }

    // invariante: toda aceptación activa pertenece a una alerta cuyo incidente existe
    const exists = (await call('GET', '/assistance/incidents', admin)).data.some((x) => x.id === inc.id);
    const callStill = (await call('GET', '/assistance/calls', admin)).data.some((c) => c.id === sc.id);
    if (accepted && (!exists || !callStill)) orphan++;
    if (!accepted && callStill) orphan++;
  }
  check(`carrera x${ROUNDS}: sin casos raros`, unexpected === 0, `borrado gana ${deletedWins}, aceptación gana ${acceptWins}`);
  check(`carrera x${ROUNDS}: sin aceptaciones huérfanas`, orphan === 0, `${orphan} huérfanas`);

  console.log(failed === 0 ? '\nTODO OK' : `\n${failed} FALLOS`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
