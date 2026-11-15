/* eslint-disable */
/**
 * ESC-DISP-01 (escalabilidad) — con 3 instancias el sistema sostiene al menos 1,5 veces las peticiones por segundo de
 * 1 instancia, con p95 de 500 ms o menos.
 *
 * Mide la capacidad (el mayor caudal sostenido con p95 ≤ 500 ms) de la operación más frecuente, la posición GPS, subiendo
 * la carga por escalones; primero con las 3 instancias y luego con 1 sola (detiene las otras dos y las vuelve a arrancar).
 *
 *   docker compose -f docker-compose.cluster.yml up -d --build
 *   npm run loadtest:scalability
 *
 *   SCALE_ONE_CMD / SCALE_THREE_CMD: comandos para dejar 1 instancia y volver a 3 (por defecto, los del entorno local).
 */
const { execSync } = require('child_process');
const { tokenFor, makeApi, makeClient, percentile } = require('./lib');

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:8080';
const ONE_CMD = process.env.SCALE_ONE_CMD ?? 'docker stop sitpverse-cluster-api-2-1 sitpverse-cluster-api-3-1';
const THREE_CMD = process.env.SCALE_THREE_CMD ?? 'docker start sitpverse-cluster-api-2-1 sitpverse-cluster-api-3-1';
const LEVELS = (process.env.SCALE_CLIENTS ?? '4,8,16,32,64,96').split(',').map(Number);
const SECONDS = Number(process.env.SCALE_SECONDS ?? 10);
const P95_LIMIT = 500;

const api = makeApi(BASE);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function instancesAlive(client) {
  const r = await client.call('GET', '/metrics');
  const match = /^sitpverse_instances (\d+)$/m.exec(typeof r.body === 'string' ? r.body : '');
  return match ? Number(match[1]) : -1;
}

async function waitForInstances(client, expected) {
  for (let i = 0; i < 60; i++) {
    if ((await instancesAlive(client)) === expected) return true;
    await sleep(1000);
  }
  return false;
}

/** `clients` clientes mandando posiciones sin pausa durante `SECONDS` segundos. */
async function run(client, fleet, clients) {
  const durations = [];
  let ok = 0;
  let errors = 0;
  const until = Date.now() + SECONDS * 1000;
  let seq = 0;
  await Promise.all(Array.from({ length: clients }, async (_, worker) => {
    const d = fleet[worker % fleet.length];
    while (Date.now() < until) {
      const latitude = Number((4.5 + (seq++ % 900000) / 1e6).toFixed(6));
      const r = await client.call('PATCH', `/fleet/buses/${d.bus.id}/position`, d.token, { latitude, longitude: -74.1 });
      durations.push(r.durationMs);
      if (r.status === 200) ok++;
      else errors++;
    }
  }));
  return { clients, rps: ok / SECONDS, p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), p99: percentile(durations, 0.99), ok, errors };
}

/**
 * Capacidad = el mayor caudal que el sistema SOSTIENE con p95 de 500 ms o menos. Se sube la carga por escalones
 * (cada vez más clientes) y se toma el mejor escalón que todavía cumple la latencia: saturarlo no cuenta.
 */
async function measure(client, fleet, label) {
  await client.warmUp(Math.max(...LEVELS));
  let best;
  for (const clients of LEVELS) {
    const result = await run(client, fleet, clients);
    const within = result.p95 <= P95_LIMIT && result.errors === 0;
    console.log(`${label.padEnd(13)} ${String(clients).padStart(4)} clientes  ${result.rps.toFixed(1).padStart(7)} pet/s   p50=${result.p50}ms p95=${result.p95}ms p99=${result.p99}ms  errores=${result.errors}  ${within ? '' : '(fuera de p95 ≤ 500 ms: no cuenta)'}`);
    if (within && (!best || result.rps > best.rps)) best = result;
  }
  if (!best) throw new Error(`${label}: ningún escalón cumplió p95 ≤ ${P95_LIMIT} ms`);
  console.log(`${label.padEnd(13)} capacidad sostenida: ${best.rps.toFixed(1)} pet/s (p95=${best.p95}ms con ${best.clients} clientes)
`);
  return best;
}

async function main() {
  console.log(`ESC-DISP-01 (escalabilidad) contra ${BASE}: escalones de ${LEVELS.join(', ')} clientes sin pausa, ${SECONDS} s cada uno\n`);
  const admin = '1001';
  const users = (await api('GET', '/users', admin)).body;
  const buses = (await api('GET', '/fleet/buses', admin)).body;
  const userId = new Map(users.map((u) => [u.employeeId, u.id]));
  const busOfDriver = new Map(buses.filter((b) => b.driverId).map((b) => [b.driverId, b]));
  const fleet = Array.from({ length: 60 }, (_, i) => String(2001 + i))
    .map((employeeId) => ({ employeeId, bus: busOfDriver.get(userId.get(employeeId)) }))
    .filter((d) => d.bus);
  for (let i = 0; i < fleet.length; i += 10) {
    await Promise.all(fleet.slice(i, i + 10).map(async (d) => (d.token = await tokenFor(BASE, d.employeeId))));
  }
  const client = makeClient(BASE, Math.max(...LEVELS) + 8);
  await Promise.all(fleet.map((d) => client.call('PATCH', `/fleet/buses/${d.bus.id}/start-trip`, d.token)));

  if (!(await waitForInstances(client, 3))) throw new Error('no están las 3 instancias vivas');
  const three = await measure(client, fleet, '3 instancias');

  console.log(`>>> ${ONE_CMD}`);
  execSync(ONE_CMD, { stdio: 'ignore' });
  let one;
  try {
    if (!(await waitForInstances(client, 1))) throw new Error('no quedó 1 sola instancia');
    await sleep(6000); // el balanceador ya dejó de enviar tráfico a las detenidas
    one = await measure(client, fleet, '1 instancia');
  } finally {
    console.log(`>>> ${THREE_CMD}`);
    execSync(THREE_CMD, { stdio: 'ignore' });
  }
  await waitForInstances(client, 3);
  client.close();

  const ratio = three.rps / one.rps;
  console.log(`\nCon 3 instancias: ${ratio.toFixed(2)} veces las peticiones por segundo de 1 instancia`);
  let failed = 0;
  const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
    if (!ok) failed++;
  };
  check('3 instancias sostienen al menos 1,5 veces el caudal de 1', ratio >= 1.5, `${ratio.toFixed(2)}×`);
  check(`…con p95 ≤ ${P95_LIMIT} ms`, three.p95 <= P95_LIMIT, `p95=${three.p95}ms`);
  check('…y sin errores', three.errors === 0, `errores=${three.errors}`);
  console.log(failed === 0 ? '\nTODO OK: ESC-DISP-01 (escalabilidad)' : `\n${failed} medida(s) FUERA del objetivo`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`FAIL  ${error.stack ?? error.message}`);
  try { execSync(THREE_CMD, { stdio: 'ignore' }); } catch { /* ya estaban arriba */ }
  process.exit(1);
});
