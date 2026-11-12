/**
 * Une la cobertura de las pruebas unitarias (Jest, `coverage/lcov.info`) con la de las pruebas de INTEGRACIÓN contra el
 * servidor real (c8, `coverage-integration/lcov.info`) y escribe `coverage/lcov.merged.info`, que es el que lee SonarCloud.
 *
 * Por qué se une así: c8 cuenta como "línea" también comentarios y llaves, lo que inflaría el porcentaje. Las líneas
 * EJECUTABLES salen de Jest (es lo que cuenta Sonar) y una línea cuenta como cubierta si la cubre cualquiera de las dos
 * pruebas. Controladores, repositorios Prisma, WebSocket y Redis solo se ejercitan de verdad contra el servidor real.
 *
 *   node scripts/merge-coverage.js
 */
const fs = require('fs');
const path = require('path');

const UNIT = 'coverage/lcov.info';
const INTEGRATION = 'coverage-integration/lcov.info';
const OUT = 'coverage/lcov.merged.info';

const normalize = (file) => path.normalize(file).replace(/\\/g, '/');

/** { archivo → Map(línea → veces) } */
function parse(file) {
  const files = new Map();
  if (!fs.existsSync(file)) return files;
  let current = null;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (raw.startsWith('SF:')) {
      current = new Map();
      files.set(normalize(raw.slice(3)), current);
    } else if (raw.startsWith('DA:') && current) {
      const [line, hits] = raw.slice(3).split(',').map(Number);
      current.set(line, (current.get(line) ?? 0) + hits);
    }
  }
  return files;
}

const unit = parse(UNIT);
const integration = parse(INTEGRATION);
if (unit.size === 0) {
  console.error(`No se encontró ${UNIT}: corre antes "npm test -- --coverage".`);
  process.exit(1);
}

let found = 0;
let hit = 0;
let hitByUnit = 0;
const out = [];
for (const [file, lines] of unit) {
  const extra = integration.get(file) ?? new Map();
  out.push('TN:', `SF:${file}`);
  let fileHit = 0;
  for (const [line, hits] of [...lines].sort((a, b) => a[0] - b[0])) {
    const total = hits + (extra.get(line) ?? 0);
    out.push(`DA:${line},${total}`);
    found++;
    if (hits > 0) hitByUnit++;
    if (total > 0) {
      hit++;
      fileHit++;
    }
  }
  out.push(`LF:${lines.size}`, `LH:${fileHit}`, 'end_of_record');
}
fs.writeFileSync(OUT, out.join('\n') + '\n');
const pct = (n) => ((100 * n) / found).toFixed(1);
console.log(`Líneas ejecutables: ${found}`);
console.log(`  solo pruebas unitarias:        ${pct(hitByUnit)} %`);
console.log(`  unitarias + integración:       ${pct(hit)} %  → ${OUT}`);
