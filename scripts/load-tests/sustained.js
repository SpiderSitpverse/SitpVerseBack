/* eslint-disable */
/**
 * ESC-REND-01 contra un despliegue REAL con un solo token de administrador: el ritmo del escenario, sostenido.
 *
 *   20 posiciones por segundo (60 conductores × 1 cada 3 s) durante `SUSTAINED_SECONDS` (60 por defecto), repartidas entre los
 *   buses, con `SUSTAINED_LISTENERS` oyentes del mapa (140 por defecto). Mide:
 *     - la respuesta HTTP de la posición  (p95 ≤ 200 ms),
 *     - de punta a punta, desde que se envía hasta que cada mapa la recibe (p95 ≤ 500 ms, p99 ≤ 1 s),
 *     - errores (< 1 %) y eventos entregados.
 *   Un administrador puede mandar la posición de cualquier bus, así que no hace falta una sesión por conductor (en
 *   producción el único inicio de sesión es el de Google y no se puede automatizar).
 *
 *   node scripts/load-tests/sustained.js https://sitpverse2026-api.azurewebsites.net      (token en .quality-token)
 */
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');
const { makeClient, percentile } = require('./lib');

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:3000';
const SECONDS = Number(process.env.SUSTAINED_SECONDS ?? 60);
const RATE = Number(process.env.SUSTAINED_RATE ?? 20);
const LISTENERS = Number(process.env.SUSTAINED_LISTENERS ?? 140);
const TOKEN = process.env.QUALITY_TOKEN ?? fs.readFileSync(path.join(__dirname, '..', '..', '.quality-token'), 'utf8').trim();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stats = (values) => ({ n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99), max: values.reduce((m, v) => (v > m ? v : m), 0) });
const fmt = (s) => `n=${s.n} p50=${s.p50}ms p95=${s.p95}ms p99=${s.p99}ms max=${s.max}ms`;
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
};

async function main() {
  const client = makeClient(BASE, 64);
  await client.warmUp(24);
  const buses = (await client.call('GET', '/fleet/buses', TOKEN)).body;
  if (!Array.isArray(buses) || buses.length === 0) throw new Error('no se pudieron leer los buses (¿el token venció?)');
  const started = [];
  for (const bus of buses) if ((await client.call('PATCH', `/fleet/buses/${bus.id}/start-trip`, TOKEN)).status === 200) started.push(bus);

  const sentAt = new Map();
  const endToEnd = [];
  let events = 0;
  const sockets = [];
  for (let i = 0; i < LISTENERS; i += 20) {
    sockets.push(...(await Promise.all(Array.from({ length: Math.min(20, LISTENERS - i) }, () => new Promise((resolve, reject) => {
      const socket = io(`${BASE}/realtime`, { auth: { token: TOKEN }, transports: ['websocket'] });
      socket.on('fleet:position-updated', (event) => {
        events++;
        const at = sentAt.get(`${event.busId}|${Number(event.latitude).toFixed(6)}`);
        if (at) endToEnd.push(Date.now() - at);
      });
      socket.once('identified', () => resolve(socket));
      socket.once('connect_error', reject);
      setTimeout(() => reject(new Error('el socket no se identificó en 20 s')), 20_000);
    })))));
  }
  console.log(`ESC-REND-01 (ritmo sostenido) contra ${BASE}: ${RATE} pet/s durante ${SECONDS} s, ${buses.length} buses, ${sockets.length} oyentes\n`);

  const http = [];
  let ok = 0;
  let bad = 0;
  const codes = new Map();
  const begin = Date.now();
  const total = SECONDS * RATE;
  const inflight = [];
  for (let n = 0; n < total; n++) {
    const wait = begin + (n * 1000) / RATE - Date.now();
    if (wait > 0) await sleep(wait);
    const bus = buses[n % buses.length];
    const latitude = Number((4.5 + (n % 5000) / 1e5).toFixed(6));
    sentAt.set(`${bus.id}|${latitude.toFixed(6)}`, Date.now());
    inflight.push(client.call('PATCH', `/fleet/buses/${bus.id}/position`, TOKEN, { latitude, longitude: -74.1 }).then((r) => {
      http.push(r.durationMs);
      codes.set(r.status, (codes.get(r.status) ?? 0) + 1);
      r.status === 200 ? ok++ : bad++;
    }));
  }
  await Promise.all(inflight);
  await sleep(2000);

  const h = stats(http);
  const e = stats(endToEnd);
  const expected = ok * sockets.length;
  console.log(`Posiciones: ${ok + bad} en ${SECONDS} s (${((ok + bad) / SECONDS).toFixed(1)} pet/s)   códigos: ${[...codes].map(([s, c]) => `${s}×${c}`).join(' ')}`);
  console.log(`Respuesta HTTP de la posición      ${fmt(h)}`);
  console.log(`Punta a punta (envío → mapa)       ${fmt(e)}`);
  console.log(`Eventos recibidos por los oyentes: ${events} de ${expected}\n`);
  check('Respuesta HTTP de la posición: p95 ≤ 200 ms', h.p95 <= 200, `p95=${h.p95}ms`);
  check('Posición de punta a punta: p95 ≤ 500 ms', e.n > 0 && e.p95 <= 500, `p95=${e.p95}ms`);
  check('Posición de punta a punta: p99 ≤ 1 s', e.n > 0 && e.p99 <= 1000, `p99=${e.p99}ms`);
  check('Menos de 1 % de errores', bad / Math.max(1, ok + bad) < 0.01, `${((bad / Math.max(1, ok + bad)) * 100).toFixed(2)} %`);
  check('Cada posición llegó a todos los oyentes', events >= expected * 0.999, `${events}/${expected}`);

  sockets.forEach((socket) => socket.close());
  for (const bus of started) await client.call('PATCH', `/fleet/buses/${bus.id}/finish-trip`, TOKEN);
  client.close();
  console.log(failed === 0 ? '\nTODO OK: ESC-REND-01 (ritmo sostenido)' : `\n${failed} medida(s) FUERA del objetivo`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`FAIL  ${error.stack ?? error.message}`);
  process.exit(1);
});
