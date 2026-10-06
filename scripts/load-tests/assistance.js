/**
 * Prueba contra la API REAL (Postgres + Redis + WebSocket) de los 2 usos de concurrencia:
 *  1) Incidente de conductor -> admin -> alerta a N conductores (primeros N aceptan)
 *  2) Fallo de bus -> alerta a mecánicos (el primero se queda la reparación)
 *
 * Requiere servidor corriendo y `npm run seed:reset` reciente.
 *   node scripts/load-test-assistance.js [baseUrl]
 */
const { makeApi, listen: openSocket } = require('./lib');
const BASE = process.argv[2] ?? 'http://localhost:3000';

const api = makeApi(BASE);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
  if (!ok) failures++;
};

const listen = (employeeId, lastSeq) => openSocket(BASE, employeeId, lastSeq);

(async () => {
  const ADMIN = '1001', ADMIN2 = '1002';
  const DRIVERS = ['2001', '2002', '2003', '2004', '2005'];
  const MECHS = ['3001', '3002', '3003'];

  const bus = (await api('GET', '/fleet/buses', ADMIN)).body[0].id;

  // Sockets por rol (así llegan las notificaciones en producción)
  const adminWs = await listen(ADMIN);
  const driverWs = await Promise.all(DRIVERS.map(listen));
  const mechWs = await Promise.all(MECHS.map(listen));

  // ───── Control de acceso ─────
  const noHeader = await fetch(`${BASE}/assistance/calls`).then((r) => r.status);
  check('Sin token -> 401', noHeader === 401);
  const driverAsAdmin = await api('GET', '/assistance/incidents', DRIVERS[1]);
  check('Un DRIVER no puede listar incidentes de admin -> 403', driverAsAdmin.status === 403);

  // ───── USO 1: apoyo de conductores ─────
  const inc = await api('POST', '/assistance/incidents', DRIVERS[0], { busId: bus, type: 'ACCIDENTE', description: 'Choque en Calle 80' });
  check('Conductor reporta incidente -> 201', inc.status === 201);
  await sleep(300);
  check('El ADMIN recibe la alerta "incident.reported" en tiempo real', adminWs.events.some((e) => e.type === 'incident.reported'));
  check('Los conductores NO reciben la alerta del incidente', driverWs.every((d) => !d.events.some((e) => e.type === 'incident.reported')));

  const [sup1, sup2] = await Promise.all([
    api('POST', `/assistance/incidents/${inc.body.id}/support-call`, ADMIN, { slots: 3, rewardPoints: 30 }),
    api('POST', `/assistance/incidents/${inc.body.id}/support-call`, ADMIN2, { slots: 3, rewardPoints: 30 }),
  ]);
  check('2 admins lanzan la alerta a la vez -> 201 + 409', [sup1.status, sup2.status].sort().join() === '201,409', `(${sup1.status},${sup2.status})`);
  const call = (sup1.status === 201 ? sup1 : sup2).body;
  await sleep(300);
  check('Los DRIVERS reciben "call.opened"', driverWs.every((d) => d.events.some((e) => e.type === 'call.opened')));
  check('Los MECHANICAL NO reciben la alerta de conductores', mechWs.every((m) => !m.events.some((e) => e.type === 'call.opened')));

  // 4 conductores (el 0 reportó) + repetidos: 12 intentos simultáneos sobre 3 cupos
  const attempts = [];
  for (let i = 0; i < 3; i++) DRIVERS.slice(1).forEach((d) => attempts.push(api('POST', `/assistance/calls/${call.id}/accept`, d)));
  const res = await Promise.all(attempts);
  const ok = res.filter((r) => r.status === 201);
  check('3 cupos / 12 intentos simultáneos -> exactamente 3 aceptados', ok.length === 3, `(aceptados=${ok.length})`);
  check('Los demás reciben 409 (cupos tomados o ya aceptada)', res.filter((r) => r.status === 409).length === 9);
  const detail = (await api('GET', '/assistance/calls', ADMIN)).body.find((c) => c.id === call.id);
  check('BD: claimedCount = 3 y status = FILLED', detail.claimedCount === 3 && detail.status === 'FILLED', `(${detail.claimedCount},${detail.status})`);
  await sleep(300);
  check('Se emite "call.closed" a los conductores (se deshabilita la notificación)', driverWs.every((d) => d.events.filter((e) => e.type === 'call.closed').length === 1));
  check('El reportante no puede aceptar su propio incidente -> 403', (await api('POST', `/assistance/calls/${call.id}/accept`, DRIVERS[0])).status === 403);
  check('Un mecánico no puede aceptar alerta de conductores -> 403', (await api('POST', `/assistance/calls/${call.id}/accept`, MECHS[0])).status === 403);

  // Completar 5 veces a la vez: puntos UNA sola vez
  const done = await Promise.all(Array.from({ length: 5 }, () => api('POST', `/assistance/calls/${call.id}/complete`, ADMIN)));
  check('Completar 5 veces a la vez -> 1 éxito', done.filter((r) => r.status === 201).length === 1, `(${done.map((d) => d.status)})`);
  const awarded = done.find((r) => r.status === 201).body.awardedUserIds.length;
  const pts = await Promise.all(DRIVERS.map(async (d) => (await api('GET', '/assistance/me', d)).body.points));
  check('Los 3 ganadores cobran 30 pts y nadie más', pts.filter((p) => p === 30).length === 3 && pts.filter((p) => p === 0).length === 2 && awarded === 3, `(${pts})`);

  // ───── USO 2: reparación por mecánico ─────
  const faults = await Promise.all([
    api('POST', '/assistance/bus-faults', DRIVERS[0], { busId: bus, description: 'Falla de frenos' }),
    api('POST', '/assistance/bus-faults', ADMIN, { busId: bus }),
    api('POST', '/assistance/bus-faults', DRIVERS[0], { busId: bus }),
  ]);
  check('3 reportes simultáneos del mismo bus -> 1 sola alerta', new Set(faults.map((f) => f.body.call.id)).size === 1 && faults.filter((f) => !f.body.duplicate).length === 1);
  const repair = faults[0].body.call;
  await sleep(300);
  check('Los mecánicos reciben UNA notificación "call.opened"', mechWs.every((m) => m.events.filter((e) => e.type === 'call.opened' && e.payload.callId === repair.id).length === 1));
  check('Los conductores NO reciben la alerta de reparación', driverWs.every((d) => !d.events.some((e) => e.payload?.callId === repair.id)));

  const racers = await Promise.all(Array.from({ length: 15 }, (_, i) => api('POST', `/assistance/calls/${repair.id}/accept`, MECHS[i % 3])));
  const winners = racers.filter((r) => r.status === 201);
  check('15 aceptaciones simultáneas de mecánicos -> exactamente 1 gana', winners.length === 1, `(${winners.length})`);
  await sleep(300);
  check('Se deshabilita la alerta para los demás mecánicos ("call.closed")', mechWs.every((m) => m.events.some((e) => e.type === 'call.closed' && e.payload.callId === repair.id)));

  const winnerEmp = MECHS.find((_, i) => racers.findIndex((r) => r.status === 201) % 3 === i);
  const loserEmp = MECHS.find((m) => m !== winnerEmp);
  check('Un mecánico que no tomó la reparación no puede completarla -> 403', (await api('POST', `/assistance/calls/${repair.id}/complete`, loserEmp)).status === 403);
  const fin = await api('POST', `/assistance/calls/${repair.id}/complete`, winnerEmp);
  check('El mecánico ganador completa la reparación -> 201', fin.status === 201);
  const bonus = (await api('GET', '/assistance/me', winnerEmp)).body.points;
  check('El ganador recibe el bono de 50 puntos', bonus === 50, `(${bonus})`);

  // ───── FIFO estricto: ganan los PRIMEROS en llegar ─────
  // Las peticiones salen con 25 ms de separación (margen mayor que la variación de las lecturas previas a la cola).
  const incF = await api('POST', '/assistance/incidents', DRIVERS[0], { busId: bus, type: 'FIFO' });
  const callF = (await api('POST', `/assistance/incidents/${incF.body.id}/support-call`, ADMIN, { slots: 2, rewardPoints: 10 })).body;
  const arrivals = ['2002', '2003', '2004', '2005'];
  const pending = [];
  for (const d of arrivals) { pending.push(api('POST', `/assistance/calls/${callF.id}/accept`, d)); await sleep(25); }
  const fifo = await Promise.all(pending);
  check('FIFO: con 2 cupos ganan los 2 primeros en llegar (2002 y 2003)', fifo.map((r) => r.status).join() === '201,201,409,409', `(${fifo.map((r) => r.status)})`);

  // ───── Plazo de 20 min visible para el admin y para quien aceptó ─────
  const adminView = (await api('GET', '/assistance/calls', ADMIN)).body.find((c) => c.id === callF.id);
  const minutes = (new Date(adminView.claims[0].arriveBy) - Date.now()) / 60000;
  check('El admin ve las 2 aceptaciones con su plazo (~20 min)', adminView.claims.length === 2 && minutes > 19 && minutes <= 20.1, `(${minutes.toFixed(1)} min)`);
  check('Ninguna aceptación está vencida todavía', adminView.claims.every((c) => c.overdue === false));
  const driverView = (await api('GET', '/assistance/calls', '2002')).body.find((c) => c.id === callF.id);
  check('El conductor ve SOLO su aceptación (con su plazo y su bus)', driverView.claims.length === 1 && driverView.claims[0].userName === 'Laura Gómez' && driverView.claims[0].busId !== null);

  // ───── El admin cancela la aceptación que no llegó y reenvía la alerta ─────
  const before = Object.fromEntries(await Promise.all(arrivals.map(async (d) => [d, (await api('GET', '/assistance/me', d)).body.points])));
  const lauraClaim = adminView.claims.find((c) => c.userName === 'Laura Gómez');
  const cancel = await api('POST', `/assistance/calls/${callF.id}/claims/${lauraClaim.id}/cancel`, ADMIN);
  check('El admin cancela la aceptación de 2002 -> 201', cancel.status === 201);
  const reopened = (await api('GET', '/assistance/calls', ADMIN)).body.find((c) => c.id === callF.id);
  check('El cupo se libera: la alerta vuelve a OPEN con 1 aceptación', reopened.status === 'OPEN' && reopened.claimedCount === 1, `(${reopened.status}, ${reopened.claimedCount})`);
  check('Cancelar dos veces la misma aceptación -> 409', (await api('POST', `/assistance/calls/${callF.id}/claims/${lauraClaim.id}/cancel`, ADMIN)).status === 409);
  const resend = await api('POST', `/assistance/calls/${callF.id}/resend`, ADMIN);
  check('El admin reenvía la alerta -> 201 (1 cupo libre)', resend.status === 201 && resend.body.remainingSlots === 1);
  await sleep(400);
  check('Los conductores reciben la alerta reenviada', driverWs.every((d) => d.events.some((e) => e.type === 'call.opened' && e.payload.callId === callF.id && e.payload.resent === true)));
  check('El cancelado (2002) recibe "claim.cancelled"', driverWs[1].events.some((e) => e.type === 'claim.cancelled' && e.payload.callId === callF.id));
  check('Los demás conductores NO reciben ese claim.cancelled', driverWs.filter((_, i) => i !== 1).every((d) => !d.events.some((e) => e.type === 'claim.cancelled')));
  const retry = await api('POST', `/assistance/calls/${callF.id}/accept`, '2002');
  check('El cancelado no puede retomar el cupo -> 409 CANCELLED', retry.status === 409 && retry.body.reason === 'CANCELLED');

  const race = [];
  for (const d of ['2004', '2005']) { race.push(api('POST', `/assistance/calls/${callF.id}/accept`, d)); await sleep(25); }
  const raced = await Promise.all(race);
  check('El cupo liberado lo toma el primero en llegar (2004), 2005 recibe 409', raced.map((r) => r.status).join() === '201,409', `(${raced.map((r) => r.status)})`);
  await api('POST', `/assistance/calls/${callF.id}/complete`, ADMIN);
  const after = Object.fromEntries(await Promise.all(arrivals.map(async (d) => [d, (await api('GET', '/assistance/me', d)).body.points])));
  const delta = (d) => after[d] - before[d];
  check('Puntos: cobran 2003 y 2004 (10 c/u); el cancelado (2002) y 2005 no', delta('2003') === 10 && delta('2004') === 10 && delta('2002') === 0 && delta('2005') === 0, `(${arrivals.map((d) => `${d}:+${delta(d)}`)})`);

  // ───── Reconexión: se reproducen los eventos que ocurrieron mientras estuvo desconectado ─────
  const lastSeq = mechWs[0].events.at(-1).seq;
  check('Los eventos llevan un seq global (para la reproducción)', /^\d+$/.test(lastSeq));
  mechWs[0].socket.close();
  const missedFault = await api('POST', '/assistance/bus-faults', ADMIN, { busId: bus, description: 'ocurre con el mecánico desconectado' });
  await sleep(500);
  const reconnected = await listen('3001', lastSeq);
  await sleep(600);
  check('Al reconectar recibe el evento que se perdió (y solo ese)', reconnected.events.length === 1 && reconnected.events[0].payload.callId === missedFault.body.call.id, `(recibió ${reconnected.events.length})`);
  reconnected.socket.close();

  // Estrés: 30 alertas x 3 cupos x 4 conductores
  const t0 = Date.now();
  const callsStress = [];
  for (let i = 0; i < 30; i++) {
    const inc2 = await api('POST', '/assistance/incidents', DRIVERS[0], { busId: bus, type: 'ESTRES' });
    callsStress.push((await api('POST', `/assistance/incidents/${inc2.body.id}/support-call`, ADMIN, { slots: 3, rewardPoints: 1 })).body);
  }
  const all = await Promise.all(callsStress.flatMap((c) => DRIVERS.slice(1).map((d) => api('POST', `/assistance/calls/${c.id}/accept`, d))));
  const ms = Date.now() - t0;
  check('Estrés: 120 aceptaciones sin errores 5xx', all.every((r) => r.status < 500), `(${ms}ms)`);
  const stressCalls = (await api('GET', '/assistance/calls', ADMIN)).body.filter((c) => callsStress.some((s) => s.id === c.id));
  check('Estrés: ninguna alerta supera sus cupos (todas con 3 de 3)', stressCalls.every((c) => c.claimedCount === 3 && c.status === 'FILLED'));

  [adminWs, ...driverWs, ...mechWs].forEach((w) => w.socket.close());
  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} verificación(es) fallaron`);
  process.exit(failures === 0 ? 0 : 1);
})();
