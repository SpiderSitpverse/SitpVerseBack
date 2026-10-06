/**
 * OUTBOX: las alertas NO se pierden aunque Redis esté caído.
 *
 *   node scripts/load-tests/outbox-recovery.js [baseUrl]
 *
 * ATENCIÓN: detiene y vuelve a iniciar el contenedor de Redis de este proyecto
 * (`docker compose stop|start redis`). Requiere servidor corriendo y `npm run seed:reset` reciente.
 */
const { execSync } = require('child_process');
const BASE = process.argv[2] ?? 'http://localhost:3000';

const { makeApi, listen } = require('./lib');
const api = makeApi(BASE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => execSync(cmd, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const psql = (sql) => sh(`docker compose exec -T postgres psql -U sitpverse -d sitpverse -tA -c "${sql}"`);
const pendingInOutbox = () => Number(psql('SELECT count(*) FROM outbox_events WHERE \\"publishedAt\\" IS NULL'));

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
  if (!ok) failures++;
};

async function until(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(250);
  }
  return false;
}

(async () => {
  const bus = (await api('GET', '/fleet/buses', '1001')).body[0].id;

  const { socket, events } = await listen(BASE, '1001');

  try {
    console.log('… deteniendo Redis');
    sh('docker compose stop redis');
    await sleep(1500);

    const incident = await api('POST', '/assistance/incidents', '2001', { busId: bus, type: 'REDIS-CAIDO' });
    check('Con Redis caído, reportar el incidente funciona igual -> 201', incident.status === 201);
    await sleep(1500);
    check('El evento todavía no llegó al admin (Redis caído)', !events.some((e) => e.payload?.incidentId === incident.body.id));
    check('El evento quedó PENDIENTE en el outbox (no se perdió)', pendingInOutbox() >= 1, `(pendientes=${pendingInOutbox()})`);

    console.log('… iniciando Redis');
    sh('docker compose start redis');
    const delivered = await until(
      () => events.some((e) => e.type === 'incident.reported' && e.payload.incidentId === incident.body.id),
      40000,
    );
    check('Al volver Redis, el admin recibe la alerta que se retuvo', delivered);
    await sleep(1500);
    const copies = events.filter((e) => e.payload?.incidentId === incident.body.id);
    check('Llega con seq y eventId (el cliente puede deduplicar)', copies.every((e) => e.seq && e.eventId));
    check('Se entrega UNA sola vez (sin cola oculta que duplique)', copies.length === 1, `(copias=${copies.length})`);
    const drained = await until(() => pendingInOutbox() === 0, 15000);
    check('El outbox queda vacío (todo marcado como publicado)', drained, `(pendientes=${pendingInOutbox()})`);
  } finally {
    try { sh('docker compose start redis'); } catch { /* ya estaba arriba */ }
    socket.close();
  }

  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} verificación(es) fallaron`);
  process.exit(failures === 0 ? 0 : 1);
})();
