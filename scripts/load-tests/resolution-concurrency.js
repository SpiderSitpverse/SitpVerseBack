/* eslint-disable */
/**
 * Carreras y tiempo real de lo que cierra, resuelve y elimina incidentes (contra Postgres y Redis reales).
 *
 *  1. Dos cierres SIMULTÁNEOS del mismo incidente (alerta de apoyo por el conductor + reparación por el mecánico):
 *     el incidente debe quedar RESUELTO siempre. Sin el bloqueo del incidente cada uno vería al otro como pendiente
 *     y ninguno lo resolvería.
 *  2. Cerrar la última alerta contra crear otra al mismo tiempo: nunca puede quedar un incidente RESUELTO con una
 *     alerta abierta dentro.
 *  3. Cerrar contra eliminar a la fuerza: ningún error 500, ningún pago por una alerta eliminada, nada huérfano.
 *  4. Tiempo real: el admin recibe `incident.resolved` una sola vez por incidente; quien ayudaba recibe
 *     `incident.deleted` con su id en `affectedUserIds` cuando el admin elimina el incidente a la fuerza.
 *  5. La grúa que termina DESPUÉS de las alertas también resuelve el incidente (y avisa).
 *
 *   BASE_URL=http://localhost:3300 SEED_PASSWORD=... node scripts/load-tests/resolution-concurrency.js
 */
const { makeApi, listen } = require('./lib');

const BASE = process.env.BASE_URL || 'http://localhost:3300';
const ROUNDS = Number(process.env.ROUNDS || 30);
const api = makeApi(BASE);
const RUN = Date.now().toString(36).toUpperCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
};

async function main() {
  const bus1 = (await api('GET', '/fleet/home/operativo', '2001')).body.busId;
  const newIncident = async () => (await api('POST', '/assistance/incidents', '2001', { busId: bus1, type: 'ACCIDENTE', description: `e2e ${RUN}` })).body;
  const support = async (id) => (await api('POST', `/assistance/incidents/${id}/support-call`, '1001', { slots: 1, rewardPoints: 10 })).body;
  const statusOf = async (id) => ((await api('GET', '/assistance/incidents', '1001')).body.find((i) => i.id === id) || {}).status;
  const points = async (e) => (await api('GET', '/assistance/me', e)).body.points;
  const adminWs = await listen(BASE, '1001');
  const helperWs = await listen(BASE, '2003');
  let serverErrors = 0;
  const track = (r) => { if (r.status >= 500) serverErrors++; return r; };

  // ───────────── 1. dos cierres simultáneos ─────────────
  console.log(`\n— 1. Dos cierres simultáneos del mismo incidente (${ROUNDS} rondas)`);
  let notResolved = 0; const ids1 = [];
  for (let i = 0; i < ROUNDS; i++) {
    const inc = await newIncident(); ids1.push(inc.id);
    const sc = await support(inc.id);
    await api('POST', `/assistance/calls/${sc.id}/accept`, '2003');
    const fault = await api('POST', '/assistance/bus-faults', '1001', { busId: bus1, incidentId: inc.id, description: 'e2e' });
    await api('POST', `/assistance/calls/${fault.body.call.id}/accept`, '3001');
    const [a, b] = await Promise.all([
      api('POST', `/assistance/calls/${sc.id}/complete`, '2001').then(track),
      api('POST', `/assistance/calls/${fault.body.call.id}/complete`, '3001').then(track),
    ]);
    if (!(a.status === 201 && b.status === 201)) { console.log('  ronda', i, 'cierres:', a.status, b.status); notResolved++; continue; }
    if ((await statusOf(inc.id)) !== 'RESOLVED') notResolved++;
  }
  check(`el incidente queda RESUELTO en las ${ROUNDS} rondas`, notResolved === 0, `${notResolved} sin resolver`);
  await sleep(800);
  const resolvedEvents = adminWs.events.filter((e) => e.type === 'incident.resolved' && ids1.includes(e.payload.incidentId));
  const perIncident = new Map(); resolvedEvents.forEach((e) => perIncident.set(e.payload.incidentId, (perIncident.get(e.payload.incidentId) || 0) + 1));
  check('el admin recibe incident.resolved exactamente una vez por incidente', perIncident.size === ROUNDS && [...perIncident.values()].every((n) => n === 1), `${perIncident.size}/${ROUNDS} incidentes, repetidos: ${[...perIncident.values()].filter((n) => n > 1).length}`);

  // ───────────── 2. cerrar la última alerta contra crear otra ─────────────
  console.log(`\n— 2. Cerrar la última alerta contra crear otra a la vez (${ROUNDS} rondas)`);
  let invariantBroken = 0, createdWins = 0, resolvedWins = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const inc = await newIncident();
    const sc = await support(inc.id);
    await api('POST', `/assistance/calls/${sc.id}/accept`, '2003');
    const [done, fault] = await Promise.all([
      api('POST', `/assistance/calls/${sc.id}/complete`, '2001').then(track),
      api('POST', '/assistance/bus-faults', '1001', { busId: bus1, incidentId: inc.id, description: 'e2e carrera' }).then(track),
    ]);
    const status = await statusOf(inc.id);
    const open = ((await api('GET', '/assistance/calls', '1001')).body || []).filter((c) => c.incidentId === inc.id && c.status !== 'COMPLETED');
    if (status === 'RESOLVED' && open.length > 0) invariantBroken++;
    if (fault.status === 201) createdWins++; else resolvedWins++;
    // limpieza: terminar lo que haya quedado abierto para que la siguiente ronda pueda crear su reparación
    for (const c of open) { await api('POST', `/assistance/calls/${c.id}/accept`, '3001'); await api('POST', `/assistance/calls/${c.id}/complete`, '1001'); }
  }
  check('nunca queda un incidente RESUELTO con una alerta abierta', invariantBroken === 0, `${invariantBroken} violaciones; ganó crear ${createdWins}, ganó resolver ${resolvedWins}`);

  // ───────────── 3. cerrar contra eliminar a la fuerza ─────────────
  console.log(`\n— 3. Cerrar contra eliminar a la fuerza (${ROUNDS} rondas)`);
  let orphans = 0, wrongPay = 0, bothOk = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const inc = await newIncident();
    const sc = await support(inc.id);
    await api('POST', `/assistance/calls/${sc.id}/accept`, '2003');
    const before = await points('2003');
    const [done, del] = await Promise.all([
      api('POST', `/assistance/calls/${sc.id}/complete`, '2001').then(track),
      api('DELETE', `/assistance/incidents/${inc.id}?force=true`, '1001').then(track),
    ]);
    const paid = (await points('2003')) - before;
    const stillThere = !!(await statusOf(inc.id));
    const callThere = ((await api('GET', '/assistance/calls', '1001')).body || []).some((c) => c.id === sc.id);
    if (del.status === 200 && (stillThere || callThere)) orphans++;
    if (done.status === 201 ? paid !== 10 : paid !== 0) wrongPay++;
    if (done.status === 201 && del.status === 200) bothOk++;
  }
  check('sin errores 500 en ninguna carrera', serverErrors === 0, `${serverErrors} errores 500`);
  check('nada huérfano: si se eliminó, no queda ni el incidente ni su alerta', orphans === 0, `${orphans} huérfanos`);
  check('se paga exactamente cuando el cierre ganó (nunca por una alerta eliminada ni dos veces)', wrongPay === 0, `${wrongPay} pagos incorrectos; cierre y borrado ambos ok: ${bothOk}`);

  // ───────────── 4. tiempo real del borrado forzado ─────────────
  console.log('\n— 4. Tiempo real: se avisa a quien ayudaba');
  const inc4 = await newIncident();
  const sc4 = await support(inc4.id);
  await api('POST', `/assistance/calls/${sc4.id}/accept`, '2003');
  const helperId = (await api('GET', '/users', '1001')).body.find((u) => u.employeeId === '2003').id;
  await api('DELETE', `/assistance/incidents/${inc4.id}?force=true`, '1001');
  await sleep(800);
  const del4 = helperWs.events.find((e) => e.type === 'incident.deleted' && e.payload.incidentId === inc4.id);
  check('el ayudante recibe incident.deleted por WebSocket', !!del4);
  check('y su id viene en affectedUserIds (el front le avisa que su aceptación se canceló)', !!del4 && del4.payload.affectedUserIds.includes(helperId));
  const otherWs = await listen(BASE, '2004');
  const inc4b = await newIncident(); await api('DELETE', `/assistance/incidents/${inc4b.id}`, '1001'); await sleep(600);
  const del4b = otherWs.events.find((e) => e.type === 'incident.deleted' && e.payload.incidentId === inc4b.id);
  check('un incidente sin nadie atendiendo trae affectedUserIds vacío', !!del4b && del4b.payload.affectedUserIds.length === 0);
  otherWs.socket.disconnect();

  // ───────────── 5. la grúa que termina después ─────────────
  console.log('\n— 5. La grúa termina después de las alertas');
  const inc5 = await newIncident();
  const sc5 = await support(inc5.id);
  await api('POST', `/assistance/calls/${sc5.id}/accept`, '2003');
  const tow = await api('POST', `/assistance/blockages/${inc5.id}/tow`, '1001', { towTruck: `G-${RUN}`, crew: `C-${RUN}` });
  await api('POST', `/assistance/calls/${sc5.id}/complete`, '2001');
  check('con la grúa todavía en servicio el incidente NO se resuelve', (await statusOf(inc5.id)) === 'HELP_REQUESTED', await statusOf(inc5.id));
  await api('POST', `/assistance/tow-assignments/${tow.body.id}/complete`, '1001');
  check('al terminar la grúa (lo último pendiente) queda RESUELTO', (await statusOf(inc5.id)) === 'RESOLVED', await statusOf(inc5.id));
  await sleep(600);
  check('y el admin recibe incident.resolved', adminWs.events.some((e) => e.type === 'incident.resolved' && e.payload.incidentId === inc5.id));
  check('no se puede abrir una reparación nueva en un incidente resuelto (409)', (await api('POST', '/assistance/bus-faults', '1001', { busId: bus1, incidentId: inc5.id })).status === 409);

  adminWs.socket.disconnect(); helperWs.socket.disconnect();
  console.log(failed === 0 ? '\nTODO OK' : `\n${failed} FALLOS`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
