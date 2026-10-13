/* eslint-disable */
/**
 * E2E contra un back real: el botón "atención recibida" y el borrado de incidentes ya atendidos.
 *
 *  1. El conductor que reportó cierra la alerta: ayudantes cobran, incidente RESUELTO (sale de la lista del admin).
 *  2. Quién puede y quién no (ayudante, otro conductor, antes de que alguien acepte).
 *  3. El admin elimina un incidente ya terminado: los puntos pagados no se pierden.
 *  4. El admin elimina uno que están atendiendo: pide confirmación (409 CLAIMED) y con force se elimina sin puntos.
 *  5. Una grúa en servicio bloquea el borrado aunque se use force.
 *  6. Una ruta alternativa asignada/aceptada pide confirmación, pero con force el incidente se puede eliminar.
 *
 *   BASE_URL=http://localhost:3300 SEED_PASSWORD=... node scripts/load-tests/help-received.js
 */
const { makeApi } = require('./lib');

const BASE = process.env.BASE_URL || 'http://localhost:3300';
const api = makeApi(BASE);
const RUN = Date.now().toString(36).toUpperCase();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
};

async function main() {
  const bus1 = (await api('GET', '/fleet/home/operativo', '2001')).body.busId;
  const newIncident = async () => (await api('POST', '/assistance/incidents', '2001', { busId: bus1, type: 'ACCIDENTE', description: `e2e ${RUN}` })).body;
  const support = async (incidentId, slots = 1, reward = 30) => (await api('POST', `/assistance/incidents/${incidentId}/support-call`, '1001', { slots, rewardPoints: reward })).body;
  const points = async (employeeId) => (await api('GET', '/assistance/me', employeeId)).body.points;
  const incidentOf = async (id) => (await api('GET', '/assistance/incidents', '1001')).body.find((i) => i.id === id);

  console.log('\n— 1. Atención recibida');
  const inc = await newIncident();
  const call = await support(inc.id);
  check('el incidente queda HELP_REQUESTED al lanzar la alerta', (await incidentOf(inc.id)).status === 'HELP_REQUESTED');

  const early = await api('POST', `/assistance/calls/${call.id}/complete`, '2001');
  check('antes de que alguien acepte no hay nada que confirmar → 409', early.status === 409, `status ${early.status}`);

  await api('POST', `/assistance/calls/${call.id}/accept`, '2003');
  const before = await points('2003');

  const byHelper = await api('POST', `/assistance/calls/${call.id}/complete`, '2003');
  check('quien ayuda no puede cerrar su propia ayuda → 403', byHelper.status === 403, `status ${byHelper.status}`);
  const byOther = await api('POST', `/assistance/calls/${call.id}/complete`, '2004');
  check('otro conductor cualquiera → 403', byOther.status === 403, `status ${byOther.status}`);

  const received = await api('POST', `/assistance/calls/${call.id}/complete`, '2001');
  check('el conductor que reportó confirma "atención recibida"', received.status === 201 && received.body.call.status === 'COMPLETED', `status ${received.status}`);
  check('el ayudante cobra los puntos', (await points('2003')) === before + 30, `${before} → ${await points('2003')}`);
  check('el incidente queda RESOLVED (sale de la lista activa del admin)', (await incidentOf(inc.id)).status === 'RESOLVED');
  const again = await api('POST', `/assistance/calls/${call.id}/complete`, '2001');
  check('confirmarla otra vez → 409 y no paga dos veces', again.status === 409 && (await points('2003')) === before + 30, `status ${again.status}`);
  const stillListed = ((await api('GET', '/assistance/calls', '2003')).body || []).some((c) => c.id === call.id);
  check('la alerta terminada sigue visible para quien la tomó (su historial)', stillListed);

  console.log('\n— 3. Eliminar un incidente ya terminado');
  const delDone = await api('DELETE', `/assistance/incidents/${inc.id}`, '1001');
  check('el admin elimina el incidente resuelto', delDone.status === 200, `status ${delDone.status}`);
  check('los puntos ya pagados NO se pierden', (await points('2003')) === before + 30);

  console.log('\n— 4. Eliminar uno que están atendiendo');
  const inc2 = await newIncident();
  const call2 = await support(inc2.id, 2, 20);
  await api('POST', `/assistance/calls/${call2.id}/accept`, '2003');
  const pts = await points('2003');
  const noForce = await api('DELETE', `/assistance/incidents/${inc2.id}`, '1001');
  check('sin confirmar → 409 con reason CLAIMED', noForce.status === 409 && noForce.body.reason === 'CLAIMED', JSON.stringify([noForce.status, noForce.body.reason]));
  check('no se tocó nada', !!(await incidentOf(inc2.id)));
  const forced = await api('DELETE', `/assistance/incidents/${inc2.id}?force=true`, '1001');
  check('con force=true el admin lo elimina', forced.status === 200, `status ${forced.status}`);
  check('el ayudante no cobra puntos por una alerta cancelada', (await points('2003')) === pts);
  const gone = ((await api('GET', '/assistance/calls', '2003')).body || []).some((c) => c.id === call2.id);
  check('y la alerta ya no aparece para él', !gone);
  const asDriver = await api('DELETE', `/assistance/incidents/${inc2.id}?force=true`, '2001');
  check('un conductor no puede usar force (403)', asDriver.status === 403, `status ${asDriver.status}`);

  console.log('\n— 5. La grúa en servicio bloquea, aunque se use force');
  const inc3 = await newIncident();
  const tow = await api('POST', `/assistance/blockages/${inc3.id}/tow`, '1001', { towTruck: `G-${RUN}`, crew: `C-${RUN}` });
  const forcedTow = await api('DELETE', `/assistance/incidents/${inc3.id}?force=true`, '1001');
  check('con grúa en servicio → 409 TOW_ACTIVE incluso con force', forcedTow.status === 409 && forcedTow.body.reason === 'TOW_ACTIVE', JSON.stringify([forcedTow.status, forcedTow.body.reason]));
  await api('POST', `/assistance/tow-assignments/${tow.body.id}/complete`, '1001');
  const afterTow = await api('DELETE', `/assistance/incidents/${inc3.id}`, '1001');
  check('terminado el servicio de grúa ya se puede eliminar', afterTow.status === 200, `status ${afterTow.status}`);

  console.log('\n— 6. Una ruta alternativa aceptada ya no deja el incidente eliminable para siempre');
  const inc4 = await newIncident();
  const route = await api('POST', `/assistance/incidents/${inc4.id}/routes`, '1001', { name: `Desvío ${RUN}`, geometry: [[4.6, -74.1], [4.7, -74.2]] });
  const users = (await api('GET', '/users', '1001')).body;
  await api('POST', `/assistance/routes/${route.body.id}/assign`, '1001', { driverId: users.find((u) => u.employeeId === '2002').id });
  await api('POST', `/assistance/routes/${route.body.id}/accept`, '2002');
  const blockedByRoute = await api('DELETE', `/assistance/incidents/${inc4.id}`, '1001');
  check('con ruta aceptada, sin confirmar → 409 ROUTE_ACTIVE', blockedByRoute.status === 409 && blockedByRoute.body.reason === 'ROUTE_ACTIVE', JSON.stringify([blockedByRoute.status, blockedByRoute.body.reason]));
  const forcedRoute = await api('DELETE', `/assistance/incidents/${inc4.id}?force=true`, '1001');
  check('con force=true se elimina (el conductor pierde el desvío)', forcedRoute.status === 200, `status ${forcedRoute.status}`);
  const mine = (await api('GET', '/assistance/routes/assigned/me', '2002')).body;
  check('y el desvío ya no aparece en el inicio del conductor', !mine.some((r) => r.id === route.body.id));

  console.log(failed === 0 ? '\nTODO OK' : `\n${failed} FALLOS`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
