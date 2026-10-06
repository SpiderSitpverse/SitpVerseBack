/**
 * FLOTA contra la API real: control de acceso por rol/propiedad y concurrencia entre las
 * posiciones del feed, el fin de viaje y los inicios de viaje duplicados.
 *   node scripts/load-tests/fleet.js [baseUrl]     (servidor corriendo + `npm run seed:reset`)
 *
 * Seed: admin 1001 · conductores 2001..2004 (cada uno con su bus TMX-00N) · mecánico 3001.
 */
const BASE = process.argv[2] ?? 'http://localhost:3000';
const { makeApi, tokenFor } = require('./lib');
const call = makeApi(BASE);

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
  if (!ok) failures++;
};

(async () => {
  const ADMIN = '1001', MECH = '3001';
  const buses = (await call('GET', '/fleet/buses', ADMIN)).body;
  const busOf = (plate) => buses.find((b) => b.plate === plate).id;
  const bus4 = busOf('TMX-004'); // conductor 2004
  const bus1 = busOf('TMX-001'); // conductor 2001
  const pos = () => ({ latitude: 4.6 + Math.random() / 100, longitude: -74.1 + Math.random() / 100 });

  // ───── Control de acceso ─────
  check('Sin token → 401', (await call('GET', '/fleet/buses')).status === 401);
  check('Token falso → 401', (await fetch(`${BASE}/fleet/buses`, { headers: { Authorization: 'Bearer token.falso.xyz' } })).status === 401);
  const driverList = await call('GET', '/fleet/buses', '2004');
  check('Un DRIVER lista solo SU bus', driverList.body.length === 1 && driverList.body[0].plate === 'TMX-004');
  check('Un DRIVER no puede ver el bus de otro → 403', (await call('GET', `/fleet/buses/${bus1}`, '2004')).status === 403);
  check('Un DRIVER no puede operar el bus de otro → 403', (await call('PATCH', `/fleet/buses/${bus1}/start-trip`, '2004')).status === 403);
  check('Un MECHANICAL puede VER cualquier bus → 200', (await call('GET', `/fleet/buses/${bus1}`, MECH)).status === 200);
  check('Un MECHANICAL no puede operar un bus → 403', (await call('PATCH', `/fleet/buses/${bus1}/start-trip`, MECH)).status === 403);
  check('Un MECHANICAL no puede mover posiciones → 403', (await call('PATCH', `/fleet/buses/${bus1}/position`, MECH, pos())).status === 403);
  const home = await call('GET', '/fleet/home/operativo', '2004');
  check('Home operativo: el conductor ve SU bus', home.status === 200 && home.body.plate === 'TMX-004');
  check('Home operativo: un ADMIN no tiene home de conductor → 403', (await call('GET', '/fleet/home/operativo', ADMIN)).status === 403);

  // ───── Concurrencia (bus de 2004, operado por su propio conductor) ─────
  const starts = await Promise.all(Array.from({ length: 10 }, () => call('PATCH', `/fleet/buses/${bus4}/start-trip`, '2004')));
  const ok = starts.filter((r) => r.status === 200).length;
  check('10 start-trip simultáneos → exactamente 1 éxito', ok === 1, `(éxitos=${ok}, códigos=${[...new Set(starts.map((s) => s.status))]})`);

  let resurrected = 0;
  const ROUNDS = 25;
  for (let i = 0; i < ROUNDS; i++) {
    if (i > 0) await call('PATCH', `/fleet/buses/${bus4}/start-trip`, '2004');
    await Promise.all([
      ...Array.from({ length: 20 }, () => call('PATCH', `/fleet/buses/${bus4}/position`, '2004', pos())),
      call('PATCH', `/fleet/buses/${bus4}/finish-trip`, '2004'),
    ]);
    await new Promise((r) => setTimeout(r, 100));
    if ((await call('GET', `/fleet/buses/${bus4}`, ADMIN)).body.status !== 'FINISHED') resurrected++;
  }
  check(`${ROUNDS} rondas (20 posiciones + finish-trip a la vez): el bus siempre queda FINISHED`, resurrected === 0, `(resucitó ${resurrected} veces)`);

  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} verificación(es) fallaron`);
  process.exit(failures === 0 ? 0 : 1);
})();
