/* eslint-disable */
/**
 * Convierte los diagramas Mermaid de `docs/diagramas/fuente/*.mmd` en imágenes PNG y SVG (para el documento de arquitectura en PDF).
 *
 *   node scripts/evidence/render-diagrams.js [carpetaFuente] [carpetaSalida]
 *
 * Abre cada diagrama en Edge o Chrome sin ventana (con su sandbox normal), lo dibuja con Mermaid (versión fija, cargada del CDN) y
 * guarda una captura recortada al diagrama, a doble resolución, con fondo blanco. No instala nada. BROWSER_PATH indica otro navegador.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js';
const source = path.resolve(process.argv[2] ?? 'docs/diagramas/fuente');
const output = path.resolve(process.argv[3] ?? 'docs/diagramas');
const SCALE = 2;

const browser = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((candidate) => fs.existsSync(candidate));
if (!browser) {
  console.error('No se encontró Edge ni Chrome (define BROWSER_PATH)');
  process.exit(2);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const page = (code) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: #fff; }
  #wrap { display: inline-block; padding: 24px; background: #fff; }
</style></head><body><div id="wrap"><pre class="mermaid" id="d">${code.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre></div>
<script src="${MERMAID}"></script>
<script>
  mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict', fontFamily: 'Segoe UI, Arial, sans-serif', flowchart: { htmlLabels: true, curve: 'basis' }, sequence: { mirrorActors: false } });
  mermaid.run({ querySelector: '#d' }).then(() => { window.__done = true; }).catch((e) => { window.__error = (e && e.message) || JSON.stringify(e); });
</script></body></html>`;

async function main() {
  const files = fs.readdirSync(source).filter((name) => name.endsWith('.mmd')).sort();
  if (files.length === 0) throw new Error(`no hay .mmd en ${source}`);
  fs.mkdirSync(output, { recursive: true });

  let current = '';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(current);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const port = 9300 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sitpverse-mmd-'));
  const chrome = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=2400,1800', 'about:blank'], { stdio: 'ignore' });
  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200);
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p) => p.type === 'page'); } catch { /* arrancando */ }
    }
    if (!target) throw new Error('el navegador no abrió el puerto de depuración');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('no se pudo conectar al navegador')); });
    let nextId = 0;
    const pending = new Map();
    socket.onmessage = (m) => {
      const data = JSON.parse(m.data);
      if (data.id && pending.has(data.id)) {
        const { resolve, reject } = pending.get(data.id);
        pending.delete(data.id);
        data.error ? reject(new Error(data.error.message)) : resolve(data.result);
      }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
    await send('Page.enable');

    for (const file of files) {
      const name = file.replace(/\.mmd$/, '');
      current = page(fs.readFileSync(path.join(source, file), 'utf8'));
      await send('Emulation.setDeviceMetricsOverride', { width: 2400, height: 1800, deviceScaleFactor: SCALE, mobile: false });
      await send('Page.navigate', { url });
      let ready = false;
      for (let i = 0; i < 100 && !ready; i++) {
        await sleep(300);
        const failure = await evaluate('window.__error');
        if (failure) throw new Error(`${name}: ${failure}`);
        ready = await evaluate('window.__done === true');
      }
      if (!ready) throw new Error(`${name}: Mermaid no terminó de dibujar (¿hay internet para cargar ${MERMAID}?)`);
      // Mermaid deja el SVG al 100 % del contenedor (que se encoge a nada): se fija a su tamaño natural.
      await evaluate(`(() => { const s = document.querySelector('#d svg'); const vb = s.viewBox.baseVal; s.setAttribute('width', vb.width); s.setAttribute('height', vb.height); s.style.maxWidth = 'none'; })()`);
      const box = await evaluate(`(() => { const r = document.getElementById('wrap').getBoundingClientRect(); return { x: r.x, y: r.y, width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`);
      // El lienzo se agranda al tamaño del diagrama para que la captura no lo recorte.
      await send('Emulation.setDeviceMetricsOverride', { width: Math.max(800, box.width), height: Math.max(600, box.height), deviceScaleFactor: SCALE, mobile: false });
      await sleep(300);
      const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: box.width, height: box.height, scale: 1 } });
      fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(shot.data, 'base64'));
      const svg = await evaluate(`document.querySelector('#d svg').outerHTML`);
      fs.writeFileSync(path.join(output, `${name}.svg`), `<?xml version="1.0" encoding="UTF-8"?>\n${svg}`);
      console.log(`${name}.png  ${box.width * SCALE}×${box.height * SCALE}`);
    }
    socket.close();
  } finally {
    chrome.kill();
    server.close();
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* carpeta temporal */ }
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(`No se pudo dibujar: ${error.message}`);
  process.exit(1);
});
