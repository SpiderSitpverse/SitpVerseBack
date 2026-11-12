/**
 * Arranca el servidor para medir la COBERTURA de las pruebas de integración (se ejecuta con `c8`, ver ci.yml).
 *
 * El servidor es el mismo (`dist/main.js`); solo se agrega una forma de apagarlo "limpio": cuando aparece el archivo
 * `STOP_FILE`, el proceso termina con `process.exit(0)` y V8 escribe la cobertura. (Una señal o un kill brusco la
 * perdería, y en Windows las señales no funcionan.)
 */
const fs = require('fs');

const STOP_FILE = process.env.STOP_FILE ?? 'coverage-integration/stop';

require('../../dist/main.js');

setInterval(() => {
  if (!fs.existsSync(STOP_FILE)) return;
  fs.unlinkSync(STOP_FILE);
  process.exit(0);
}, 500);
