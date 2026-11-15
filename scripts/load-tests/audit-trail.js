/* eslint-disable */
/**
 * ESC-SEG-03 — Trazabilidad, contra un back real (Postgres + Redis):
 *
 *  1. Ejecuta CADA acción crítica (viaje, inspección, evidencia, incidente, grúa, alerta, reparación, ruta, bus) y
 *     comprueba que queda su registro de auditoría con el actor, el recurso, el resultado, la IP y el trace_id.
 *  2. Los intentos rechazados (sin el rol, o sobre el bus de otro) y los fallidos también quedan (DENIED / FAILURE).
 *  3. El registro de una acción que cambia la base se guarda EN LA MISMA TRANSACCIÓN: si el cambio se revierte, no
 *     queda registro de éxito, y nunca hay dos registros del mismo cambio.
 *  4. Las inspecciones son inmutables: ni la API ni un acceso directo a la base pueden modificarlas o borrarlas.
 *  5. La hoja de vida de un bus sale con una sola petición, en 2 s o menos.
 *
 *   node scripts/load-tests/audit-trail.js [baseUrl]
 */
const { PrismaClient } = require('@prisma/client');
const { makeApi, tokenFor } = require('./lib');

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:3000';
const api = makeApi(BASE);
const prisma = new PrismaClient();
const RUN = Date.now().toString(36).toUpperCase();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
};

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]), Buffer.alloc(64)]);
async function uploadImage(employeeId) {
  const form = new FormData();
  form.append('photo', new Blob([JPEG], { type: 'image/jpeg' }), 'foto.jpg');
  const r = await fetch(`${BASE}/files/images`, { method: 'POST', headers: { Authorization: `Bearer ${await tokenFor(BASE, employeeId)}` }, body: form });
  return r.json();
}

/** Registros de auditoría de una acción sobre un recurso (los más recientes primero). */
async function auditOf(action, resourceId, outcome) {
  const query = new URLSearchParams({ action, limit: '50' });
  if (resourceId) query.set('resourceId', resourceId);
  if (outcome) query.set('outcome', outcome);
  return (await api('GET', `/audit?${query}`, '1001')).body;
}

async function main() {
  const users = (await api('GET', '/users', '1001')).body;
  const idOf = (employeeId) => users.find((u) => u.employeeId === employeeId).id;
  const busOf = async (employeeId) => (await api('GET', '/fleet/home/operativo', employeeId)).body.busId;
  const bus1 = await busOf('2001');
  const bus2 = await busOf('2002');

  /**
   * Ejecuta la acción y comprueba que deja EXACTAMENTE un registro de éxito, con el actor y el recurso correctos.
   * `resourceId` puede ser una función del cuerpo de la respuesta.
   */
  const expectAudited = async (label, action, actor, resourceType, resourceId, run) => {
    const before = (await auditOf(action, resourceId, 'SUCCESS')).length;
    const response = await run();
    const ok = response.status >= 200 && response.status < 300;
    const records = await auditOf(action, resourceId, 'SUCCESS');
    const record = records[0];
    const good =
      ok &&
      records.length === before + 1 &&
      record.actorId === idOf(actor) &&
      record.actorEmail &&
      record.actorRole &&
      record.resourceType === resourceType &&
      (resourceId ? record.resourceId === resourceId : true) &&
      record.ip &&
      /^[A-Za-z0-9._-]{8,64}$/.test(record.traceId ?? '');
    check(`${label} → ${action}`, good, good ? '' : JSON.stringify({ status: response.status, nuevos: records.length - before, record }));
    return response.body;
  };

  // ───────────────────────── 1. Cada acción crítica deja su registro ─────────────────────────
  console.log('\n— 1. Cada acción crítica deja su registro (quién, qué, sobre qué, resultado, IP y trace_id)');

  await expectAudited('el conductor inicia el viaje de su bus', 'trip.start', '2001', 'bus', bus1,
    () => api('PATCH', `/fleet/buses/${bus1}/start-trip`, '2001'));

  const photo = await uploadImage('2001');
  check('subir una foto → file.upload', (await auditOf('file.upload', undefined, 'SUCCESS')).some((r) => r.actorId === idOf('2001')));

  await expectAudited('el conductor registra la inspección de su bus', 'inspection.register', '2001', 'bus', bus1,
    () => api('POST', '/inspections', '2001', { busId: bus1, note: `Inspección ${RUN}`, photos: [photo.url] }));

  const incident = await expectAudited('el conductor reporta un incidente', 'incident.report', '2001', 'bus', bus1,
    () => api('POST', '/assistance/incidents', '2001', { busId: bus1, type: 'ACCIDENTE', description: `audit ${RUN}` }));

  await expectAudited('adjunta evidencia fotográfica', 'evidence.attach', '2001', 'incident', incident.id,
    () => api('POST', `/assistance/incidents/${incident.id}/evidence`, '2001', { url: photo.url, caption: 'golpe lateral' }));

  await expectAudited('el admin avisa a la flota del bloqueo', 'fleet_alert.send', '1001', 'incident', incident.id,
    () => api('POST', `/assistance/blockages/${incident.id}/alert`, '1001'));

  const tow = await expectAudited('el admin asigna una grúa', 'tow.assign', '1001', 'incident', incident.id,
    () => api('POST', `/assistance/blockages/${incident.id}/tow`, '1001', { towTruck: `G-${RUN}`, crew: `C-${RUN}` }));

  const route = await expectAudited('el admin propone una ruta alternativa', 'route.create', '1001', 'incident', incident.id,
    () => api('POST', `/assistance/incidents/${incident.id}/routes`, '1001', { name: `Desvío ${RUN}`, geometry: [[4.6, -74.1], [4.61, -74.11]] }));

  await expectAudited('el admin asigna la ruta a un conductor', 'route.assign', '1001', 'route', route.id,
    () => api('POST', `/assistance/routes/${route.id}/assign`, '1001', { driverId: idOf('2002') }));
  const assigned = (await auditOf('route.assign', route.id, 'SUCCESS'))[0];
  check('…y el registro dice a QUÉ conductor (solo el id, nunca el cuerpo completo)', assigned?.detail?.ids?.driverId === idOf('2002'), JSON.stringify(assigned?.detail));

  await expectAudited('el conductor acepta la ruta', 'route.accept', '2002', 'route', route.id,
    () => api('POST', `/assistance/routes/${route.id}/accept`, '2002'));

  const support = await expectAudited('el admin lanza la alerta de apoyo (2 cupos)', 'support_call.request', '1001', 'incident', incident.id,
    () => api('POST', `/assistance/incidents/${incident.id}/support-call`, '1001', { slots: 2, rewardPoints: 10 }));
  const supportCallId = support.id ?? support.call?.id;

  await expectAudited('un conductor acepta la alerta', 'call.accept', '2003', 'call', supportCallId,
    () => api('POST', `/assistance/calls/${supportCallId}/accept`, '2003'));

  await expectAudited('el admin reenvía la alerta', 'call.resend', '1001', 'call', supportCallId,
    () => api('POST', `/assistance/calls/${supportCallId}/resend`, '1001'));

  const fault = await expectAudited('el conductor reporta una falla del bus', 'bus_fault.report', '2002', 'bus', bus2,
    () => api('POST', '/assistance/bus-faults', '2002', { busId: bus2, description: `falla ${RUN}` }));
  const repairId = fault.call?.id ?? fault.id;

  await expectAudited('un mecánico acepta la reparación', 'call.accept', '3001', 'call', repairId,
    () => api('POST', `/assistance/calls/${repairId}/accept`, '3001'));

  await expectAudited('el mecánico guarda el informe de reparación', 'repair_report.save', '3001', 'call', repairId,
    () => api('PUT', `/assistance/calls/${repairId}/repair-report`, '3001', { damages: 'Pastillas gastadas', replacedParts: 'Pastillas' }));

  await expectAudited('el admin cierra la alerta de apoyo', 'call.complete', '1001', 'call', supportCallId,
    () => api('POST', `/assistance/calls/${supportCallId}/complete`, '1001'));

  await expectAudited('el admin cierra el servicio de grúa (al final: cerrar la grúa resuelve el incidente)', 'tow.complete', '1001', 'tow_assignment', tow.id,
    () => api('POST', `/assistance/tow-assignments/${tow.id}/complete`, '1001'));

  await expectAudited('el conductor finaliza el viaje', 'trip.finish', '2001', 'bus', bus1,
    () => api('PATCH', `/fleet/buses/${bus1}/finish-trip`, '2001'));

  const plate = `AU${RUN.slice(-4)}`.slice(0, 7);
  const created = await api('POST', '/fleet/buses', '1001', { plate, route: 'B23' });
  check('el admin registra un bus → bus.create', created.status === 201 && (await auditOf('bus.create', undefined, 'SUCCESS')).some((r) => r.actorId === idOf('1001')), `status ${created.status}`);

  await expectAudited('el admin edita la ficha del bus', 'bus.update', '1001', 'bus', created.body.id,
    () => api('PATCH', `/fleet/buses/${created.body.id}`, '1001', { model: 'Biarticulado', capacity: 250 }));

  await expectAudited('el admin quita el conductor del bus', 'bus.assign_driver', '1001', 'bus', created.body.id,
    () => api('PATCH', `/fleet/buses/${created.body.id}/driver`, '1001', { driverId: null }));

  await expectAudited('el admin elimina un incidente', 'incident.delete', '1001', 'incident', incident.id,
    () => api('DELETE', `/assistance/incidents/${incident.id}?force=true`, '1001'));

  // ───────────────────────── 2. Rechazos y fallos ─────────────────────────
  console.log('\n— 2. Los intentos rechazados y fallidos también quedan');

  const deniedRole = await api('POST', `/assistance/blockages/${incident.id}/tow`, '2001', { towTruck: 'G-X', crew: 'C-X' });
  const deniedRoleRecord = (await auditOf('tow.assign', incident.id, 'DENIED'))[0];
  check('un conductor intenta asignar una grúa → 403 y registro DENIED con su identidad',
    deniedRole.status === 403 && deniedRoleRecord?.actorId === idOf('2001') && deniedRoleRecord?.actorRole === 'DRIVER',
    JSON.stringify([deniedRole.status, deniedRoleRecord?.outcome]));

  const deniedBus = await api('PATCH', `/fleet/buses/${bus1}/start-trip`, '2004');
  const deniedBusRecord = (await auditOf('trip.start', bus1, 'DENIED'))[0];
  check('el conductor 2004 intenta iniciar el viaje del bus de otro → 403 y registro DENIED',
    deniedBus.status === 403 && deniedBusRecord?.actorId === idOf('2004'), JSON.stringify([deniedBus.status, deniedBusRecord?.actorId]));

  await api('PATCH', `/fleet/buses/${bus2}/start-trip`, '2002');
  const beforeOk = (await auditOf('trip.start', bus2, 'SUCCESS')).length;
  const twice = await api('PATCH', `/fleet/buses/${bus2}/start-trip`, '2002');
  const failure = (await auditOf('trip.start', bus2, 'FAILURE'))[0];
  check('iniciar un viaje que ya está en curso → 409 y registro FAILURE (no un éxito falso)',
    twice.status === 409 && failure?.actorId === idOf('2002') && (await auditOf('trip.start', bus2, 'SUCCESS')).length === beforeOk,
    JSON.stringify([twice.status, failure?.outcome]));
  await api('PATCH', `/fleet/buses/${bus2}/finish-trip`, '2002');

  // ───────────────────────── 3. Misma transacción ─────────────────────────
  console.log('\n— 3. El cambio y su registro van en la misma transacción');

  // 12 conductores por una alerta de 1 cupo: exactamente 1 cambio y exactamente 1 registro de éxito.
  const inc2 = (await api('POST', '/assistance/incidents', '2001', { busId: bus1, type: 'ACCIDENTE', description: `carrera ${RUN}` })).body;
  const race = (await api('POST', `/assistance/incidents/${inc2.id}/support-call`, '1001', { slots: 1, rewardPoints: 5 })).body;
  const raceId = race.id ?? race.call?.id;
  const attempts = await Promise.all(['2002', '2003', '2004', '2005'].map((d) => api('POST', `/assistance/calls/${raceId}/accept`, d)));
  const winners = attempts.filter((r) => r.status === 201 || r.status === 200).length;
  const successes = await auditOf('call.accept', raceId, 'SUCCESS');
  const failures = await auditOf('call.accept', raceId, 'FAILURE');
  check('4 conductores por 1 cupo: 1 cupo tomado = 1 registro de éxito; los otros 3 quedan como FAILURE',
    winners === 1 && successes.length === 1 && failures.length === 3, JSON.stringify({ winners, exitos: successes.length, fallos: failures.length }));

  const claims = await prisma.assistanceClaim.count({ where: { callId: raceId, status: 'ACTIVE' } });
  check('en la base: cupos tomados = registros de éxito (no hay cambio sin registro ni registro sin cambio)', claims === successes.length, `claims ${claims}`);

  // ───────────────────────── 4. Inspecciones inmutables ─────────────────────────
  console.log('\n— 4. Las inspecciones no se pueden modificar ni borrar');

  const inspection = await prisma.busInspection.findFirst({ where: { busId: bus1 }, orderBy: { createdAt: 'desc' } });
  const adminToken = await tokenFor(BASE, '1001');
  for (const method of ['PATCH', 'PUT', 'DELETE']) {
    const r = await fetch(`${BASE}/inspections/${inspection.id}`, { method, headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: method === 'DELETE' ? undefined : '{"note":"alterada"}' });
    check(`${method} /inspections/:id no existe (ni el admin) → 404`, r.status === 404, `(${r.status})`);
  }
  let updateRejected = false, deleteRejected = false;
  try { await prisma.$executeRaw`UPDATE bus_inspections SET note = 'alterada' WHERE id = ${inspection.id}`; } catch (e) { updateRejected = /solo inserci/.test(String(e)); }
  try { await prisma.$executeRaw`DELETE FROM bus_inspections WHERE id = ${inspection.id}`; } catch (e) { deleteRejected = /solo inserci/.test(String(e)); }
  check('con acceso directo a la base, UPDATE sobre una inspección es rechazado por la propia base', updateRejected);
  check('…y DELETE también', deleteRejected);
  const still = await prisma.busInspection.findUnique({ where: { id: inspection.id } });
  check('la inspección sigue intacta', still?.note === inspection.note);

  // ───────────────────────── 5. Hoja de vida del bus ─────────────────────────
  console.log('\n— 5. Hoja de vida del bus con una sola consulta');

  const t0 = performance.now();
  const history = await api('GET', `/fleet/buses/${bus1}/history`, '1001');
  const elapsed = performance.now() - t0;
  const h = history.body;
  check('GET /fleet/buses/:id/history responde en 2 s o menos', history.status === 200 && elapsed <= 2000, `(${elapsed.toFixed(0)} ms)`);
  check('trae los viajes iniciados y finalizados, con quién los hizo',
    h.events?.some((e) => e.action === 'trip.start' && e.actorId === idOf('2001')) && h.events?.some((e) => e.action === 'trip.finish'));
  check('trae las inspecciones con sus fotos y quién las registró',
    h.inspections?.some((i) => i.note === `Inspección ${RUN}` && i.photos?.[0] === photo.url && i.inspectorId === idOf('2001')));
  check('trae los incidentes del bus (para saber si un daño ya estaba reportado antes del cambio de turno)',
    h.incidents?.some((i) => i.description === `carrera ${RUN}` && i.reportedById === idOf('2001')));
  check('las listas vienen de la más reciente a la más antigua',
    h.events.every((e, i) => i === 0 || new Date(h.events[i - 1].at) >= new Date(e.at)));
  const h2 = (await api('GET', `/fleet/buses/${bus2}/history`, '1001')).body;
  check('trae las reparaciones con el informe del mecánico', h2.repairs?.some((r) => r.callId === repairId && r.mechanicName && r.damages === 'Pastillas gastadas'), JSON.stringify(h2.repairs?.[0]));
  check('un conductor no puede ver la hoja de vida → 403', (await api('GET', `/fleet/buses/${bus1}/history`, '2001')).status === 403);
  check('bus inexistente → 404', (await api('GET', '/fleet/buses/00000000-0000-4000-8000-000000000000/history', '1001')).status === 404);

  await prisma.$disconnect();
  console.log(failed === 0 ? '\nTODO OK: ESC-SEG-03 (trazabilidad)' : `\n${failed} comprobación(es) FALLARON`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
