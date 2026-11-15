/**
 * Quality scenarios 4 and 5:
 *   node scripts/load-tests/quality.js [baseUrl]
 *
 * Requires the API, PostgreSQL, Redis and seed data to be running.
 * QUALITY_REQUESTS and QUALITY_P95_MS can tune the workload and acceptance threshold.
 * Authentication: QUALITY_TOKEN or the git-ignored file .quality-token (session token of an ADMIN user) against a real deployment; without it the script logs in
 * as employee 1001 through the fake Google IdP (scripts/load-tests/fake-google.js), as the other integration scripts do.
 */
const { io } = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const { tokenFor, makeClient, percentile } = require('./lib');

const BASE = process.argv[2] ?? 'http://localhost:3000';
const REQUESTS = Number(process.env.QUALITY_REQUESTS ?? 100);
const P95_LIMIT = Number(process.env.QUALITY_P95_MS ?? 500);
let TOKEN;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const client = makeClient(BASE, Math.max(REQUESTS, 16));
const call = (method, path, authenticated, body) =>
  client.call(method, path, authenticated ? TOKEN : undefined, body, { 'x-trace-id': `quality-${Date.now()}` });

/** Un secreto guardado en un archivo de la raíz del proyecto, ignorado por git (`.quality-token`, `.metrics-token`). */
function readSecretFile(name) {
  try {
    return fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}
const readTokenFile = () => readSecretFile('.quality-token');

async function main() {
  TOKEN = process.env.QUALITY_TOKEN ?? readTokenFile() ?? (await tokenFor(BASE, '1001'));
  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` ${detail}` : ''}`);
  };

  const live = await call('GET', '/health/live');
  check('Liveness endpoint', live.status === 200);
  const ready = await call('GET', '/health/ready');
  check('Readiness endpoint', ready.status === 200 && ready.body.status === 'ok');
  // Con METRICS_TOKEN definido en el servidor, /metrics exige ese token (QUALITY_METRICS_TOKEN o el archivo .metrics-token).
  const metricsToken = process.env.QUALITY_METRICS_TOKEN ?? readSecretFile('.metrics-token');
  const metrics = await client.call('GET', '/metrics', metricsToken);
  check(
    'Prometheus metrics endpoint',
    metrics.status === 200 && typeof metrics.body === 'string',
  );

  const buses = await call('GET', '/fleet/buses', true);
  if (!Array.isArray(buses.body) || buses.body.length === 0) throw new Error('No seeded bus found');
  // Las posiciones se reparten entre TODOS los buses, como en la operación real (cada bus manda la suya). Mandarlas
  // todas al mismo bus mediría otra cosa: PostgreSQL bloquea la fila y las atiende una tras otra.
  const fleet = buses.body.slice(0, Number(process.env.QUALITY_BUSES ?? 60));
  const startedHere = [];
  for (const bus of fleet) {
    const started = await call('PATCH', `/fleet/buses/${bus.id}/start-trip`, true);
    if (started.status === 200) startedHere.push(bus); // 409 = ya estaba en servicio: no se toca al terminar
  }
  const fleetIds = new Set(fleet.map((bus) => bus.id));
  const socket = io(`${BASE}/realtime`, {
    auth: { token: TOKEN, batch: true },
    transports: ['websocket'],
  });
  const eventLatencies = [];
  const sentAtByLatitude = new Map();
  let received = 0;
  const onPosition = (event) => {
    if (!fleetIds.has(event.busId)) return;
    received += 1;
    // Un solo reloj (el de esta máquina): desde que se ENVÍA la posición hasta que el mapa recibe el evento. Incluye la
    // ida por HTTP, así que es una cota superior de la medida del escenario y no depende de relojes sincronizados.
    const sentAt = sentAtByLatitude.get(Number(event.latitude).toFixed(5));
    if (sentAt) eventLatencies.push(Date.now() - sentAt);
  };
  socket.on('fleet:positions-batch', (batch) => batch.forEach(onPosition)); // la última posición de cada bus cada 250 ms
  await new Promise((resolve, reject) => {
    socket.once('identified', resolve);
    socket.once('connect_error', reject);
  });

  // Los clientes reales mantienen su conexión abierta: se abren antes de medir (no se mide el saludo TLS).
  await client.warmUp(REQUESTS);
  const results = await Promise.all(
    Array.from({ length: REQUESTS }, (_, index) => {
      const latitude = Number((4.6 + index / 100000).toFixed(5));
      sentAtByLatitude.set(latitude.toFixed(5), Date.now());
      const bus = fleet[index % fleet.length];
      return call('PATCH', `/fleet/buses/${bus.id}/position`, true, { latitude, longitude: -74.1 - index / 100000 });
    }),
  );
  await sleep(1500);
  socket.close();
  // Los buses que esta prueba puso en servicio vuelven a quedar como estaban.
  for (const bus of startedHere) await call('PATCH', `/fleet/buses/${bus.id}/finish-trip`, true);
  const metricsAfter = await client.call('GET', '/metrics', metricsToken);
  client.close();

  const httpLatencies = results.map((result) => result.durationMs);
  const successful = results.filter((result) => result.status === 200).length;
  const p95Http = percentile(httpLatencies, 0.95);
  const p95Realtime = percentile(eventLatencies, 0.95);
  check('Concurrent position updates preserve success', successful === REQUESTS, `success=${successful}/${REQUESTS}`);
  check('Realtime events are delivered', received > 0, `received=${received}`);
  check('HTTP p95 stays below threshold', p95Http <= P95_LIMIT, `p95=${p95Http}ms limit=${P95_LIMIT}ms`);
  check('Realtime p95 stays below threshold', p95Realtime <= P95_LIMIT, `p95=${p95Realtime}ms limit=${P95_LIMIT}ms`);

  if (typeof metricsAfter.body === 'string') {
    const lines = metricsAfter.body.split('\n');
    const instances = lines.filter((line) => line.startsWith('sitpverse_http_requests_total') && line.includes('/fleet/buses/:id/position') && line.includes('status="200"'));
    console.log('\nMetrics after the test (GET /metrics):');
    for (const line of [...lines.filter((l) => /^sitpverse_(instances|dependency_up)/.test(l)), ...instances]) console.log(`  ${line}`);
  }
  console.log(`\nTarget: ${BASE}   concurrent requests: ${REQUESTS}   p95 limit: ${P95_LIMIT}ms`);
  console.log(`Buses: ${fleet.length}`);
  console.log(`HTTP      success=${successful}/${REQUESTS}  p50=${percentile(httpLatencies, 0.5)}ms p95=${p95Http}ms p99=${percentile(httpLatencies, 0.99)}ms`);
  console.log(`Realtime  events=${received} samples=${eventLatencies.length}  p50=${percentile(eventLatencies, 0.5)}ms p95=${p95Realtime}ms p99=${percentile(eventLatencies, 0.99)}ms`);
  process.exit(checks.every(Boolean) ? 0 : 1);
}

main().catch((error) => {
  console.error(`FAIL  Quality load test: ${error.message}${error.cause ? ` (${error.cause.code ?? error.cause.message})` : ""}`);
  process.exit(1);
});
