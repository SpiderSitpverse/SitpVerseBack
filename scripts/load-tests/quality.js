/**
 * Quality scenarios 4 and 5:
 *   node scripts/load-tests/quality.js [baseUrl]
 *
 * Requires the API, PostgreSQL, Redis and seed data to be running.
 * QUALITY_REQUESTS and QUALITY_P95_MS can tune the workload and acceptance threshold.
 */
const { io } = require('socket.io-client');

const BASE = process.argv[2] ?? 'http://localhost:3000';
const REQUESTS = Number(process.env.QUALITY_REQUESTS ?? 100);
const P95_LIMIT = Number(process.env.QUALITY_P95_MS ?? 500);
const ADMIN = '1001';
const DRIVER = '2001';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
};
const call = (method, path, employeeId, body) => {
  const started = Date.now();
  return fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-employee-id': employeeId },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (response) => {
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* Prometheus is plain text. */ }
    return { status: response.status, body, durationMs: Date.now() - started };
  });
};

async function main() {
  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` ${detail}` : ''}`);
  };

  const live = await call('GET', '/health/live');
  check('Liveness endpoint', live.status === 200);
  const ready = await call('GET', '/health/ready');
  check('Readiness endpoint', ready.status === 200 && ready.body.status === 'ok');
  const metrics = await call('GET', '/metrics');
  check(
    'Prometheus metrics endpoint',
    metrics.status === 200 && typeof metrics.body === 'string',
  );

  const buses = await call('GET', '/fleet/buses', ADMIN);
  const bus = buses.body.find((candidate) => candidate.plate === 'TMX-001') ?? buses.body[0];
  if (!bus) throw new Error('No seeded bus found');

  await call('PATCH', `/fleet/buses/${bus.id}/start-trip`, DRIVER);
  const socket = io(`${BASE}/realtime`, {
    auth: { employeeId: ADMIN },
    transports: ['websocket'],
  });
  const eventLatencies = [];
  let received = 0;
  socket.on('fleet:position-updated', (event) => {
    if (event.busId !== bus.id) return;
    received += 1;
    if (event.occurredAt) eventLatencies.push(Date.now() - Date.parse(event.occurredAt));
  });
  await new Promise((resolve, reject) => {
    socket.once('identified', resolve);
    socket.once('connect_error', reject);
  });

  const results = await Promise.all(
    Array.from({ length: REQUESTS }, (_, index) =>
      call('PATCH', `/fleet/buses/${bus.id}/position`, DRIVER, {
        latitude: 4.6 + index / 100000,
        longitude: -74.1 - index / 100000,
      }),
    ),
  );
  await sleep(500);
  socket.close();

  const httpLatencies = results.map((result) => result.durationMs);
  const successful = results.filter((result) => result.status === 200).length;
  const p95Http = percentile(httpLatencies, 0.95);
  const p95Realtime = percentile(eventLatencies, 0.95);
  check('Concurrent position updates preserve success', successful === REQUESTS, `success=${successful}/${REQUESTS}`);
  check('Realtime events are delivered', received > 0, `received=${received}`);
  check('HTTP p95 stays below threshold', p95Http <= P95_LIMIT, `p95=${p95Http}ms limit=${P95_LIMIT}ms`);
  check('Realtime p95 stays below threshold', p95Realtime <= P95_LIMIT, `p95=${p95Realtime}ms limit=${P95_LIMIT}ms`);

  console.log(`\nHTTP p50=${percentile(httpLatencies, 0.5)}ms p95=${p95Http}ms`);
  console.log(`Realtime samples=${eventLatencies.length} p50=${percentile(eventLatencies, 0.5)}ms p95=${p95Realtime}ms`);
  process.exit(checks.every(Boolean) ? 0 : 1);
}

main().catch((error) => {
  console.error(`FAIL  Quality load test: ${error.message}`);
  process.exit(1);
});
