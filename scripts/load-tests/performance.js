/* eslint-disable */
/**
 * ESC-REND-01 — Latencia de los eventos en tiempo real bajo concurrencia (hora pico).
 *
 *   200 clientes: 60 conductores mandando su posición cada 3 s (20 peticiones por segundo) y 140 administradores y
 *   mecánicos viendo el mapa. En medio de la carga:
 *     - el centro de control avisa a la flota de un bloqueo (alerta a los 60 conductores),
 *     - 12 conductores aceptan a la vez una alerta de apoyo de 3 cupos,
 *     - 5 mecánicos aceptan a la vez una misma reparación,
 *     - y se consulta el detalle de un bus (HU-13) con `bus_positions` cargada con una hora de historial.
 *
 * Conductores y oyentes corren en ESTA máquina: todo se mide con un solo reloj. La latencia de punta a punta se mide
 * desde que el conductor ENVÍA la posición hasta que cada mapa recibe el evento (incluye la ida por HTTP: es una cota
 * superior de la medida del escenario, que cuenta desde que el backend la recibe).
 *
 *   docker compose -f docker-compose.cluster.yml up -d --build
 *   npm run loadtest:performance                       # contra http://localhost:8080 (3 instancias + balanceador)
 *   PERF_DURATION_S=120 node scripts/load-tests/performance.js http://localhost:8080
 *
 * Requiere los datos de hora pico (`SEED_LOAD_BUSES=60 npm run seed:reset`; el entorno de 3 instancias ya los trae).
 */
const { io } = require('socket.io-client');
const { tokenFor, makeApi, makeClient, percentile } = require('./lib');

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:8080';
const DURATION_S = Number(process.env.PERF_DURATION_S ?? 60);
const DRIVERS = Number(process.env.PERF_DRIVERS ?? 60);
const LISTENERS = Number(process.env.PERF_LISTENERS ?? 140);
const INTERVAL_MS = Number(process.env.PERF_INTERVAL_MS ?? 3000);
/** Filas de historial que se cargan antes de medir el detalle del bus: una hora pico son ~72 000 (60 buses cada 3 s). */
const PRELOAD_POSITIONS = Number(process.env.PERF_PRELOAD_POSITIONS ?? 72000);

const LIMITS = {
  positionHttpP95: 200,
  endToEndP95: 500,
  endToEndP99: 1000,
  blockageAlertP95: 1000,
  acceptP95: 800,
  busDetailP95: 300,
  errorRate: 0.01,
};

const api = makeApi(BASE);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stats = (values) => ({ n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99), max: values.reduce((m, v) => (v > m ? v : m), 0) });
const fmt = (s) => `n=${s.n} p50=${s.p50}ms p95=${s.p95}ms p99=${s.p99}ms max=${s.max}ms`;

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
};

const employeeOf = { driver: (n) => String(2000 + n), admin: (n) => String(1001 + (n % 5)), mechanic: (n) => String(3001 + (n % 5)) };

async function openSocket(token, onPosition, onAssistance) {
  const socket = io(`${BASE}/realtime`, { auth: { token }, transports: ['websocket'], reconnection: true });
  if (onPosition) socket.on('fleet:position-updated', onPosition);
  if (onAssistance) socket.on('assistance:event', onAssistance);
  await new Promise((resolve, reject) => {
    socket.once('identified', resolve);
    socket.once('unauthorized', () => reject(new Error('socket rechazado')));
    setTimeout(() => reject(new Error('el socket no se identificó en 15 s')), 15_000);
  });
  return socket;
}

async function preloadPositions(busIds) {
  if (PRELOAD_POSITIONS <= 0) return 0;
  let prisma;
  try {
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();
    const existing = await prisma.busPosition.count();
    const missing = PRELOAD_POSITIONS - existing;
    const start = Date.now() - 3600_000;
    for (let done = 0; done < missing; done += 5000) {
      const size = Math.min(5000, missing - done);
      await prisma.busPosition.createMany({
        data: Array.from({ length: size }, (_, i) => {
          const n = done + i;
          return { busId: busIds[n % busIds.length], latitude: 4.6 + (n % 1000) / 10000, longitude: -74.1, recordedAt: new Date(start + (n / PRELOAD_POSITIONS) * 3600_000) };
        }),
      });
    }
    return prisma.busPosition.count();
  } catch (error) {
    console.log(`AVISO  no se pudo precargar bus_positions (${String(error.message).split('\n')[0]}): el detalle del bus se mide con el historial que haya`);
    return -1;
  } finally {
    await prisma?.$disconnect().catch(() => undefined);
  }
}

async function main() {
  console.log(`ESC-REND-01 contra ${BASE}: ${DRIVERS} conductores cada ${INTERVAL_MS} ms (${(DRIVERS / (INTERVAL_MS / 1000)).toFixed(0)} pet/s), ${LISTENERS} oyentes, ${DURATION_S} s\n`);

  // ───────── Preparación: sesiones, buses y viajes ─────────
  const drivers = Array.from({ length: DRIVERS }, (_, i) => employeeOf.driver(i + 1));
  const admin = '1001';
  const users = (await api('GET', '/users', admin)).body;
  const buses = (await api('GET', '/fleet/buses', admin)).body;
  if (!Array.isArray(users) || !Array.isArray(buses)) throw new Error('no se pudo leer usuarios o buses (¿el servidor está arriba y con datos?)');
  const userId = new Map(users.map((u) => [u.employeeId, u.id]));
  const busOfDriver = new Map(buses.filter((b) => b.driverId).map((b) => [b.driverId, b]));
  const fleet = drivers.map((employeeId) => ({ employeeId, bus: busOfDriver.get(userId.get(employeeId)) })).filter((d) => d.bus);
  if (fleet.length < DRIVERS) {
    throw new Error(`solo hay ${fleet.length} conductores con bus; se necesitan ${DRIVERS} (SEED_LOAD_BUSES=${DRIVERS} npm run seed:reset)`);
  }

  const rows = await preloadPositions(fleet.map((d) => d.bus.id));
  if (rows > 0) console.log(`bus_positions precargada: ${rows} filas (una hora pico)`);

  // Inicios de sesión de a 10 (no es lo que se mide; así no se satura el login).
  for (let i = 0; i < fleet.length; i += 10) {
    await Promise.all(fleet.slice(i, i + 10).map(async (d) => (d.token = await tokenFor(BASE, d.employeeId))));
  }
  const adminTokens = await Promise.all([0, 1, 2, 3, 4].map((n) => tokenFor(BASE, employeeOf.admin(n))));
  const mechanicTokens = await Promise.all([0, 1, 2, 3, 4].map((n) => tokenFor(BASE, employeeOf.mechanic(n))));

  const client = makeClient(BASE, DRIVERS + 40);
  await client.warmUp(DRIVERS);
  const started = await Promise.all(fleet.map((d) => client.call('PATCH', `/fleet/buses/${d.bus.id}/start-trip`, d.token)));
  const inService = started.filter((r) => r.status === 200 || r.status === 409).length; // 409 = ya estaba en servicio
  check('Los 60 buses quedan en servicio', inService === fleet.length, `${inService}/${fleet.length}`);

  // ───────── 140 oyentes del mapa (70 administradores y 70 mecánicos) + los 60 conductores ─────────
  const sentAt = new Map(); // `${busId}|${latitud}` → cuándo se envió
  const endToEnd = [];
  const fromBackend = [];
  let positionEvents = 0;
  const onPosition = (event) => {
    positionEvents++;
    const key = `${event.busId}|${Number(event.latitude).toFixed(6)}`;
    const at = sentAt.get(key);
    const now = Date.now();
    if (at) endToEnd.push(now - at);
    if (event.occurredAt) fromBackend.push(now - Date.parse(event.occurredAt));
  };
  const listeners = [];
  for (let i = 0; i < LISTENERS; i += 20) {
    listeners.push(...(await Promise.all(Array.from({ length: Math.min(20, LISTENERS - i) }, (_, k) => {
      const n = i + k;
      return openSocket(n % 2 === 0 ? adminTokens[n % 5] : mechanicTokens[n % 5], onPosition);
    }))));
  }

  let positionsToDrivers = 0;
  const alertSeenBy = new Map(); // tipo de evento → [{ driver, at }]
  const driverSockets = [];
  for (let i = 0; i < fleet.length; i += 20) {
    driverSockets.push(...(await Promise.all(fleet.slice(i, i + 20).map((d) =>
      openSocket(d.token, () => positionsToDrivers++, (event) => {
        const list = alertSeenBy.get(event.type) ?? [];
        list.push({ driver: d.employeeId, at: Date.now(), eventId: event.eventId, payload: event.payload });
        alertSeenBy.set(event.type, list);
      })))));
  }
  check(`Conectados los 200 clientes (${LISTENERS} oyentes + ${fleet.length} conductores)`, listeners.length === LISTENERS && driverSockets.length === fleet.length);

  // ───────── Carga: cada conductor manda su posición cada 3 s ─────────
  const positionHttp = [];
  let positionOk = 0;
  let positionFailed = 0;
  const statuses = new Map();
  let running = true;
  const driverLoops = fleet.map(async (d, index) => {
    await sleep((index / fleet.length) * INTERVAL_MS); // repartidos en la ventana: 20 por segundo, parejo
    let seq = 0;
    while (running) {
      const tick = Date.now();
      const latitude = Number((4.5 + index / 100 + seq / 1e6).toFixed(6));
      seq++;
      sentAt.set(`${d.bus.id}|${latitude.toFixed(6)}`, tick);
      const r = await client.call('PATCH', `/fleet/buses/${d.bus.id}/position`, d.token, { latitude, longitude: -74.1 });
      positionHttp.push(r.durationMs);
      statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
      if (r.status === 200) positionOk++;
      else positionFailed++;
      await sleep(Math.max(0, INTERVAL_MS - (Date.now() - tick)));
    }
  });

  // Detalle de un bus (HU-13) durante toda la carga.
  const detail = [];
  const detailLoop = (async () => {
    let n = 0;
    while (running) {
      const r = await client.call('GET', `/fleet/buses/${fleet[n++ % fleet.length].bus.id}`, adminTokens[0]);
      if (r.status === 200) detail.push(r.durationMs);
      await sleep(250);
    }
  })();

  const t = (fraction) => sleep(DURATION_S * 1000 * fraction);

  // ───────── 1/4: alerta de bloqueo a toda la flota ─────────
  await t(0.25);
  const blockage = await client.call('POST', '/assistance/blockages', fleet[0].token, { busId: fleet[0].bus.id, type: 'BLOQUEO', description: 'Bloqueo en la Troncal Caracas' });
  const alertSentAt = Date.now();
  const alert = await client.call('POST', `/assistance/blockages/${blockage.body.id}/alert`, adminTokens[0]);
  await sleep(3000);
  const alerted = (alertSeenBy.get('blockage.alerted') ?? []).filter((e) => e.payload?.incidentId === blockage.body.id);
  const alertLatency = stats(alerted.map((e) => e.at - alertSentAt));
  check('Alerta de bloqueo entregada a los 60 conductores (0 perdidas)', alert.status === 201 && new Set(alerted.map((e) => e.driver)).size === fleet.length,
    `${new Set(alerted.map((e) => e.driver)).size}/${fleet.length}`);
  check(`Alerta de bloqueo: p95 ≤ ${LIMITS.blockageAlertP95} ms`, alertLatency.p95 <= LIMITS.blockageAlertP95, fmt(alertLatency));

  // ───────── 1/2: 12 conductores aceptan a la vez una alerta de 3 cupos ─────────
  await t(0.2);
  const incident = await client.call('POST', '/assistance/incidents', fleet[0].token, { busId: fleet[0].bus.id, type: 'ACCIDENTE', description: 'Choque en la Calle 80' });
  const support = await client.call('POST', `/assistance/incidents/${incident.body.id}/support-call`, adminTokens[0], { slots: 3, rewardPoints: 30 });
  const supportId = support.body.id ?? support.body.call?.id;
  await sleep(500);
  const accepts = await Promise.all(fleet.slice(1, 13).map((d) => client.call('POST', `/assistance/calls/${supportId}/accept`, d.token)));
  const won = accepts.filter((r) => r.status === 201).length;
  const conflicts = accepts.filter((r) => r.status === 409).length;
  const acceptLatency = stats(accepts.map((r) => r.durationMs));
  check('12 aceptaciones sobre 3 cupos: exactamente 3 éxitos y 9 respuestas 409', won === 3 && conflicts === 9, `éxitos=${won} 409=${conflicts} otros=${12 - won - conflicts}`);
  check(`Aceptaciones: p95 ≤ ${LIMITS.acceptP95} ms`, acceptLatency.p95 <= LIMITS.acceptP95, fmt(acceptLatency));

  // ───────── 3/4: 5 mecánicos aceptan a la vez una misma reparación ─────────
  await t(0.2);
  const fault = await client.call('POST', '/assistance/bus-faults', adminTokens[0], { busId: fleet[20].bus.id, description: 'Falla de frenos' });
  const repairId = fault.body.call?.id ?? fault.body.id;
  await sleep(500);
  const repairs = await Promise.all(mechanicTokens.map((token) => client.call('POST', `/assistance/calls/${repairId}/accept`, token)));
  const repairWon = repairs.filter((r) => r.status === 201).length;
  check('5 mecánicos sobre 1 reparación: exactamente 1 éxito', repairWon === 1 && repairs.filter((r) => r.status === 409).length === 4,
    `éxitos=${repairWon} 409=${repairs.filter((r) => r.status === 409).length}`);

  // ───────── Fin de la carga ─────────
  await t(0.35);
  running = false;
  await Promise.all([...driverLoops, detailLoop]);
  await sleep(1500); // los últimos eventos en vuelo

  const sent = positionOk + positionFailed;
  const errorRate = sent ? positionFailed / sent : 1;
  const http = stats(positionHttp);
  const e2e = stats(endToEnd);
  const backend = stats(fromBackend);
  const detailStats = stats(detail);
  const expectedDeliveries = positionOk * LISTENERS;

  console.log(`\nPosiciones enviadas: ${sent} en ${DURATION_S} s (${(sent / DURATION_S).toFixed(1)} pet/s)   códigos: ${[...statuses].map(([s, n]) => `${s}×${n}`).join(' ')}`);
  console.log(`Posición · respuesta HTTP        ${fmt(http)}`);
  console.log(`Posición · punta a punta (envío → mapa)   ${fmt(e2e)}`);
  console.log(`Posición · backend → mapa        ${fmt(backend)}   (misma máquina: un solo reloj)`);
  console.log(`Eventos de posición recibidos por los ${LISTENERS} oyentes: ${positionEvents} de ${expectedDeliveries} (${((positionEvents / Math.max(1, expectedDeliveries)) * 100).toFixed(2)} %)`);
  console.log(`Alerta de bloqueo → 60 conductores  ${fmt(alertLatency)}`);
  console.log(`12 aceptaciones sobre 3 cupos       ${fmt(acceptLatency)}`);
  console.log(`Detalle de un bus (HU-13)           ${fmt(detailStats)}\n`);

  check(`Respuesta HTTP de la posición: p95 ≤ ${LIMITS.positionHttpP95} ms`, http.p95 <= LIMITS.positionHttpP95, `p95=${http.p95}ms`);
  check(`Posición de punta a punta: p95 ≤ ${LIMITS.endToEndP95} ms`, e2e.n > 0 && e2e.p95 <= LIMITS.endToEndP95, `p95=${e2e.p95}ms`);
  check(`Posición de punta a punta: p99 ≤ ${LIMITS.endToEndP99} ms`, e2e.n > 0 && e2e.p99 <= LIMITS.endToEndP99, `p99=${e2e.p99}ms`);
  check(`Detalle de un bus: p95 ≤ ${LIMITS.busDetailP95} ms`, detailStats.n > 0 && detailStats.p95 <= LIMITS.busDetailP95, `p95=${detailStats.p95}ms`);
  check('Menos de 1 % de errores', errorRate < LIMITS.errorRate, `${(errorRate * 100).toFixed(2)} %`);
  check('Cada posición llegó a los 140 oyentes', positionEvents >= expectedDeliveries * 0.999, `${positionEvents}/${expectedDeliveries}`);
  check('0 eventos de posición entregados a conductores (ESC-SEG-02)', positionsToDrivers === 0, `${positionsToDrivers}`);

  [...listeners, ...driverSockets].forEach((socket) => socket.close());
  client.close();
  console.log(failed === 0 ? '\nTODO OK: ESC-REND-01 (rendimiento)' : `\n${failed} medida(s) FUERA del objetivo`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`FAIL  ${error.stack ?? error.message}`);
  process.exit(1);
});
