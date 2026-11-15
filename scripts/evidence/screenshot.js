/* eslint-disable */
/**
 * Captura de pantalla de una página con Edge o Chrome sin ventana (para la evidencia de los escenarios de calidad).
 *
 *   node scripts/evidence/screenshot.js <url> <salida.png> [--width 1920] [--height 1200] [--wait 8000]
 *        [--grafana usuario:clave]          inicia sesión en Grafana antes de abrir la página
 *        [--header "Nombre: valor"]         cabecera extra en todas las peticiones (p. ej. Authorization)
 *
 * Usa el protocolo de depuración del navegador (CDP) con el WebSocket de Node 22: no instala nada.
 * BROWSER_PATH permite indicar otro ejecutable.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const [url, output] = args;
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
if (!url || !output) {
  console.error('uso: node scripts/evidence/screenshot.js <url> <salida.png> [--width N] [--height N] [--wait ms] [--grafana u:c] [--header "N: v"]');
  process.exit(2);
}
const width = Number(option('width', 1920));
const height = Number(option('height', 1200));
const wait = Number(option('wait', 8000));
const grafana = option('grafana');
const header = option('header');

const candidates = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const browser = candidates.find((candidate) => fs.existsSync(candidate));
if (!browser) {
  console.error('No se encontró Edge ni Chrome (define BROWSER_PATH)');
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const port = 9300 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sitpverse-shot-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200);
      try {
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = pages.find((page) => page.type === 'page');
      } catch { /* el navegador aún está arrancando */ }
    }
    if (!target) throw new Error('el navegador no abrió el puerto de depuración');

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error('no se pudo conectar al navegador'));
    });
    let nextId = 0;
    const pending = new Map();
    socket.onmessage = (message) => {
      const data = JSON.parse(message.data);
      if (data.id && pending.has(data.id)) {
        const { resolve, reject } = pending.get(data.id);
        pending.delete(data.id);
        data.error ? reject(new Error(data.error.message)) : resolve(data.result);
      }
    };
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });

    await send('Page.enable');
    await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    if (header) {
      const separator = header.indexOf(':');
      await send('Network.setExtraHTTPHeaders', { headers: { [header.slice(0, separator).trim()]: header.slice(separator + 1).trim() } });
    }

    if (grafana) {
      const [user, password] = [grafana.slice(0, grafana.indexOf(':')), grafana.slice(grafana.indexOf(':') + 1)];
      await send('Page.navigate', { url: `${new URL(url).origin}/login` });
      await sleep(2500);
      const login = await send('Runtime.evaluate', {
        awaitPromise: true,
        returnByValue: true,
        expression: `fetch('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: ${JSON.stringify(user)}, password: ${JSON.stringify(password)} }) }).then((r) => r.status)`,
      });
      if (login.result.value !== 200) throw new Error(`Grafana rechazó el inicio de sesión (${login.result.value})`);
    }

    await send('Page.navigate', { url });
    await sleep(wait);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, Buffer.from(shot.data, 'base64'));
    console.log(`captura guardada: ${output}`);
    socket.close();
  } finally {
    child.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* el navegador aún lo suelta: es una carpeta temporal */ }
  }
}

main().catch((error) => {
  console.error(`No se pudo capturar: ${error.message}`);
  process.exit(1);
});
