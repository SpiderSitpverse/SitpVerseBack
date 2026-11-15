/* eslint-disable */
/**
 * ESC-DISP-01 — El backend sobrevive a la caída de una instancia en hora pico.
 *
 *   Con 60 buses enviando su GPS, 140 usuarios viendo el mapa y una alerta de apoyo de 3 cupos abierta, una de las 3
 *   instancias del backend se detiene DE GOLPE (`docker kill`). Se mide:
 *     - cuánto tarda la instancia en salir del balanceador y en desaparecer de las métricas,
 *     - cuánto tardan en reconectarse los sockets que atendía (y que no pierdan alertas: `lastSeq`),
 *     - que cada posición GPS quede registrada en 6 s o menos gracias al reintento del cliente (ningún bus «Sin señal»),
 *     - los errores HTTP que ve el usuario durante la falla y después,
 *     - que no se pierdan alertas ni se sobreasignen cupos, y que ningún bus cambie de estado por la falla.
 *
 *   docker compose -f docker-compose.cluster.yml up -d --build
 *   npm run loadtest:availability
 *
 * La instancia se detiene y se vuelve a arrancar con comandos configurables (por defecto, los del entorno de 3 instancias):
 *   AVAIL_KILL_CMD="docker kill sitpverse-cluster-api-2-1"   AVAIL_RESTORE_CMD="docker start sitpverse-cluster-api-2-1"
 */
const { execSync } = require('child_process');
const { io } = require('socket.io-client');
const { tokenFor, makeApi, makeClient, percentile } = require('./lib');

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:8080';
const KILL_CMD = process.env.AVAIL_KILL_CMD ?? 'docker kill sitpverse-cluster-api-2-1';
const RESTORE_CMD = process.env.AVAIL_RESTORE_CMD ?? 'docker start sitpverse-cluster-api-2-1';
const DRIVERS = Number(process.env.AVAIL_DRIVERS ?? 60);
const LISTENERS = Number(process.env.AVAIL_LISTENERS ?? 140);
const INTERVAL_MS = 3000;
const BEFORE_S = Number(process.env.AVAIL_BEFORE_S ?? 20); // carga normal antes de la falla
const DURING_S = Number(process.env.AVAIL_DURING_S ?? 40); // con la instancia caída
const AFTER_S = Number(process.env.AVAIL_AFTER_S ?? 20); // después de arrancarla de nuevo

const LIMITS = { outOfBalancerMs: 120_000, metricsMs: 30_000, reconnectMs: 20_000, positionMs: 6_000, noSignalMs: 15_000, errorsDuring: 0.01 };
/** El cliente reintenta las peticiones que fallan por red o por 502/503/504 (como hace el front). */
const RETRIES = 3;
const RETRY_BACKOFF_MS = [200, 600, 1500];

const api = makeApi(BASE);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stats = (values) => ({ n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99), max: values.reduce((m, v) => (v > m ? v : m), 0) });
const fmt = (s) => `n=${s.n} p50=${s.p50}ms p95=${s.p95}ms p99=${s.p99}ms max=${s.max}ms`;

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
};

const retriable = (status) => status === 0 || status === 502 || status === 503 || status === 504;

async function instancesAlive(client) {
  const r = await client.call('GET', '/metrics');
  const match = /^sitpverse_instances (\d+)$/m.exec(typeof r.body === 'string' ? r.body : '');
  return match ? Number(match[1]) : -1;
}

/** Socket que recuerda el último `seq` y lo manda al reconectar (como el front), y mide cuánto tarda en volver. */
function openSocket(token, handlers = {}) {
  const state = { lastSeq: undefined, droppedAt: undefined, reconnects: [], connected: false, seen: new Set() };
  const socket = io(`${BASE}/realtime`, {
    auth: (cb) => cb({ token, lastSeq: state.lastSeq, batch: true }),
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 2000,
    timeout: 5000,
  });
  socket.on('identified', (info) => {
    if (state.lastSeq === undefined && info?.seq !== undefined) state.lastSeq = String(info.seq);
    if (state.droppedAt !== undefined) {
      state.reconnects.push(Date.now() - state.droppedAt);
      state.droppedAt = undefined;
    }
    state.connected = true;
  });
  socket.on('disconnect', () => {
    state.connected = false;
    if (state.droppedAt === undefined) state.droppedAt = Date.now();
  });
  socket.on('fleet:position-updated', (event) => handlers.onPosition?.(event));
  socket.on('fleet:positions-batch', (batch) => batch.forEach((event) => handlers.onPosition?.(event)));
  socket.on('assistance:event', (event) => {
    if (state.seen.has(event.eventId)) return; // entrega "al menos una vez": se descartan los repetidos
    state.seen.add(event.eventId);
    if (event.seq !== undefined && (state.lastSeq === undefined || BigInt(event.seq) > BigInt(state.lastSeq))) state.lastSeq = String(event.seq);
    handlers.onAssistance?.(event);
  });
  const ready = new Promise((resolve, reject) => {
    socket.once('identified', resolve);
    socket.once('unauthorized', () => reject(new Error('socket rechazado')));
    setTimeout(() => reject(new Error('el socket no se identificó en 15 s')), 15_000);
  });
  return { socket, state, ready };
}

async function main() {
  console.log(`ESC-DISP-01 contra ${BASE}: ${DRIVERS} buses cada 3 s, ${LISTENERS} oyentes; falla a los ${BEFORE_S} s, ${DURING_S} s con la instancia caída\n`);

  const admin = '1001';
  const users = (await api('GET', '/users', admin)).body;
  const buses = (await api('GET', '/fleet/buses', admin)).body;
  if (!Array.isArray(users) || !Array.isArray(buses)) throw new Error('no se pudo leer usuarios o buses');
  const userId = new Map(users.map((u) => [u.employeeId, u.id]));
  const busOfDriver = new Map(buses.filter((b) => b.driverId).map((b) => [b.driverId, b]));
  const fleet = Array.from({ length: DRIVERS }, (_, i) => String(2001 + i))
    .map((employeeId) => ({ employeeId, bus: busOfDriver.get(userId.get(employeeId)) }))
    .filter((d) => d.bus);
  if (fleet.length < DRIVERS) throw new Error(`solo hay ${fleet.length} conductores con bus; se necesitan ${DRIVERS}`);

  for (let i = 0; i < fleet.length; i += 10) {
    await Promise.all(fleet.slice(i, i + 10).map(async (d) => (d.token = await tokenFor(BASE, d.employeeId))));
  }
  const adminTokens = await Promise.all([0, 1, 2, 3, 4].map((n) => tokenFor(BASE, String(1001 + n))));
  const mechanicTokens = await Promise.all([0, 1, 2, 3, 4].map((n) => tokenFor(BASE, String(3001 + n))));

  const client = makeClient(BASE, DRIVERS + 40);
  const before = await instancesAlive(client);
  check('Las 3 instancias están vivas antes de la falla', before === 3, `instancias=${before}`);

  await Promise.all(fleet.map((d) => client.call('PATCH', `/fleet/buses/${d.bus.id}/start-trip`, d.token)));

  // ───────── 140 oyentes del mapa + 60 conductores ─────────
  let positionEvents = 0;
  const listeners = [];
  for (let i = 0; i < LISTENERS; i += 20) {
    const batch = Array.from({ length: Math.min(20, LISTENERS - i) }, (_, k) =>
      openSocket((i + k) % 2 === 0 ? adminTokens[(i + k) % 5] : mechanicTokens[(i + k) % 5], { onPosition: () => positionEvents++ }));
    await Promise.all(batch.map((s) => s.ready));
    listeners.push(...batch);
  }
  const alerts = new Map(); // incidentId → Set de conductores que recibieron la alerta
  const driverSockets = [];
  for (let i = 0; i < fleet.length; i += 20) {
    const batch = fleet.slice(i, i + 20).map((d) =>
      openSocket(d.token, {
        onAssistance: (event) => {
          if (event.type !== 'blockage.alerted') return;
          const seen = alerts.get(event.payload?.incidentId) ?? new Set();
          seen.add(d.employeeId);
          alerts.set(event.payload?.incidentId, seen);
        },
      }));
    await Promise.all(batch.map((s) => s.ready));
    driverSockets.push(...batch);
  }
  const sockets = [...listeners, ...driverSockets];
  check('Conectados los 200 clientes por WebSocket', sockets.every((s) => s.state.connected), `${sockets.filter((s) => s.state.connected).length}/200`);

  // ───────── Carga: posición cada 3 s, con reintento ─────────
  const positions = []; // { at, tookMs, ok, attempts, firstFailed }
  const lastOkByBus = new Map();
  const worstGapByBus = new Map();
  let running = true;
  let killedAt;
  let restoredAt;
  const rawFailures = []; // instantes de intentos que fallaron ANTES del reintento
  const loops = fleet.map(async (d, index) => {
    await sleep((index / fleet.length) * INTERVAL_MS);
    let seq = 0;
    while (running) {
      const startedAt = Date.now();
      const latitude = Number((4.5 + index / 100 + seq++ / 1e6).toFixed(6));
      let attempts = 0;
      let response;
      do {
        if (attempts > 0) await sleep(RETRY_BACKOFF_MS[attempts - 1]);
        response = await client.call('PATCH', `/fleet/buses/${d.bus.id}/position`, d.token, { latitude, longitude: -74.1 });
        attempts++;
        if (retriable(response.status)) rawFailures.push(Date.now());
      } while (retriable(response.status) && attempts <= RETRIES);
      const done = Date.now();
      const ok = response.status === 200;
      positions.push({ at: startedAt, tookMs: done - startedAt, ok, attempts });
      if (ok) {
        const previous = lastOkByBus.get(d.bus.id);
        if (previous) worstGapByBus.set(d.bus.id, Math.max(worstGapByBus.get(d.bus.id) ?? 0, done - previous));
        lastOkByBus.set(d.bus.id, done);
      }
      await sleep(Math.max(0, INTERVAL_MS - (Date.now() - startedAt)));
    }
  });

  // Alerta de apoyo de 3 cupos, abierta ANTES de la falla.
  await sleep(BEFORE_S * 500);
  const incident = await client.call('POST', '/assistance/incidents', fleet[0].token, { busId: fleet[0].bus.id, type: 'ACCIDENTE', description: 'Choque en hora pico' });
  const support = await client.call('POST', `/assistance/incidents/${incident.body.id}/support-call`, adminTokens[0], { slots: 3, rewardPoints: 30 });
  const supportId = support.body.id ?? support.body.call?.id;
  check('Alerta de apoyo de 3 cupos abierta antes de la falla', support.status === 201, `status ${support.status}`);
  await sleep(BEFORE_S * 500);

  // ───────── LA FALLA: una instancia se detiene de golpe ─────────
  console.log(`\n>>> ${KILL_CMD}`);
  execSync(KILL_CMD, { stdio: 'ignore' });
  killedAt = Date.now();

  // Mientras los sockets de esa instancia se reconectan: alerta de bloqueo a toda la flota y 12 aceptaciones a la vez.
  const blockage = await client.call('POST', '/assistance/blockages', fleet[1].token, { busId: fleet[1].bus.id, type: 'BLOQUEO', description: 'Bloqueo durante la falla' });
  const alert = await client.call('POST', `/assistance/blockages/${blockage.body.id}/alert`, adminTokens[1]);
  const accepts = await Promise.all(fleet.slice(2, 14).map(async (d) => {
    let response;
    let attempts = 0;
    do {
      if (attempts > 0) await sleep(RETRY_BACKOFF_MS[attempts - 1]);
      response = await client.call('POST', `/assistance/calls/${supportId}/accept`, d.token);
      attempts++;
    } while (retriable(response.status) && attempts <= RETRIES);
    return response;
  }));

  // ¿Cuándo desaparece la instancia de las métricas (lo que muestra el tablero técnico)?
  let metricsDroppedMs;
  for (let i = 0; i < 60 && metricsDroppedMs === undefined; i++) {
    if ((await instancesAlive(client)) === 2) metricsDroppedMs = Date.now() - killedAt;
    else await sleep(1000);
  }

  await sleep(Math.max(0, DURING_S * 1000 - (Date.now() - killedAt)));
  const droppedSockets = sockets.filter((s) => s.state.reconnects.length > 0 || s.state.droppedAt !== undefined);
  const reconnectTimes = droppedSockets.flatMap((s) => s.state.reconnects);
  const stillDown = droppedSockets.filter((s) => !s.state.connected).length;

  console.log(`>>> ${RESTORE_CMD}`);
  execSync(RESTORE_CMD, { stdio: 'ignore' });
  restoredAt = Date.now();
  await sleep(AFTER_S * 1000);
  running = false;
  await Promise.all(loops);
  await sleep(1000);

  // ───────── Resultados ─────────
  const phase = (from, to) => positions.filter((p) => p.at >= from && p.at < to);
  const during = phase(killedAt, restoredAt);
  const after = phase(killedAt + 30_000, Infinity); // "después": pasada la ventana de la falla
  const errorsDuring = during.filter((p) => !p.ok).length / Math.max(1, during.length);
  const errorsAfter = after.filter((p) => !p.ok).length / Math.max(1, after.length);
  const lastRawFailure = rawFailures.filter((t) => t >= killedAt).reduce((m, t) => Math.max(m, t), killedAt);
  const outOfBalancerMs = lastRawFailure - killedAt;
  const within6s = positions.filter((p) => p.ok && p.tookMs <= LIMITS.positionMs).length / Math.max(1, positions.length);
  const worstGap = [...worstGapByBus.values()].reduce((m, v) => Math.max(m, v), 0);
  const retried = positions.filter((p) => p.attempts > 1).length;
  const reconnect = stats(reconnectTimes);

  const call = (await api('GET', '/assistance/calls', admin)).body.find?.((c) => c.id === supportId);
  const won = accepts.filter((r) => r.status === 201).length;
  const alertedDrivers = alerts.get(blockage.body.id)?.size ?? 0;
  const busesAfter = (await api('GET', '/fleet/buses', admin)).body;
  const stillInService = fleet.filter((d) => busesAfter.find((b) => b.id === d.bus.id)?.status === 'IN_SERVICE').length;
  const finalInstances = await instancesAlive(client);

  console.log(`\nPosiciones: ${positions.length} en total, ${during.length} durante la falla; ${retried} necesitaron reintento; ${rawFailures.length} intentos fallidos antes del reintento`);
  console.log(`Tiempo en registrar cada posición (con reintentos)   ${fmt(stats(positions.filter((p) => p.ok).map((p) => p.tookMs)))}`);
  console.log(`Sockets que atendía la instancia caída: ${droppedSockets.length} de 200; reconexión ${fmt(reconnect)}`);
  console.log(`Mayor hueco entre dos posiciones de un mismo bus: ${worstGap} ms`);
  console.log(`Eventos de posición recibidos por los oyentes: ${positionEvents}\n`);

  check('Instancia fuera del balanceador en 2 min o menos', outOfBalancerMs <= LIMITS.outOfBalancerMs, `último intento fallido ${outOfBalancerMs} ms después de la falla`);
  check('La caída se ve en las métricas (tablero técnico) en 30 s o menos', metricsDroppedMs !== undefined && metricsDroppedMs <= LIMITS.metricsMs, `${metricsDroppedMs} ms`);
  check('La falla afectó de verdad a clientes conectados', droppedSockets.length > 0, `${droppedSockets.length} sockets cortados`);
  check('100 % de los sockets reconectados en 20 s o menos', stillDown === 0 && reconnect.max <= LIMITS.reconnectMs, `sin reconectar=${stillDown} máx=${reconnect.max}ms`);
  check('99 % o más de las posiciones GPS registradas en 6 s o menos', within6s >= 0.99, `${(within6s * 100).toFixed(2)} %`);
  check('Ningún bus pasó a «Sin señal» (más de 15 s sin posición)', worstGap < LIMITS.noSignalMs, `mayor hueco ${worstGap} ms`);
  check('Errores HTTP visibles para el usuario ≤ 1 % durante la falla', errorsDuring <= LIMITS.errorsDuring, `${(errorsDuring * 100).toFixed(2)} % de ${during.length}`);
  check('0 % de errores después de la falla', errorsAfter === 0, `${(errorsAfter * 100).toFixed(2)} % de ${after.length}`);
  check('0 alertas perdidas: la alerta enviada durante la falla llegó a los 60 conductores', alert.status === 201 && alertedDrivers === fleet.length, `${alertedDrivers}/${fleet.length}`);
  check('0 sobreasignaciones: 12 aceptaciones durante la falla → exactamente 3 cupos tomados', won === 3 && call?.claimedCount === 3, `éxitos=${won} cupos tomados=${call?.claimedCount}`);
  check('Ningún bus cambió de estado por la falla (los 60 siguen en servicio)', stillInService === fleet.length, `${stillInService}/${fleet.length}`);
  check('Al arrancar de nuevo, la instancia vuelve al grupo (3 vivas)', finalInstances === 3, `instancias=${finalInstances}`);

  sockets.forEach((s) => s.socket.close());
  client.close();
  console.log(failed === 0 ? '\nTODO OK: ESC-DISP-01 (disponibilidad)' : `\n${failed} medida(s) FUERA del objetivo`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`FAIL  ${error.stack ?? error.message}`);
  try { execSync(RESTORE_CMD, { stdio: 'ignore' }); } catch { /* ya estaba arriba */ }
  process.exit(1);
});
