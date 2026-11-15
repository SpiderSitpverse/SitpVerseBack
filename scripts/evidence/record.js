/* eslint-disable */
/**
 * Graba un VIDEO (.mp4) de una demostración, para la evidencia de los escenarios de calidad:
 *   - a la izquierda, una terminal que corre un comando EN VIVO (p. ej. la prueba que detiene una instancia);
 *   - a la derecha, una página (p. ej. el tablero técnico de Grafana) que se actualiza mientras tanto.
 * Se puede grabar solo la terminal (sin --url) o solo la página (sin --cmd).
 *
 *   node scripts/evidence/record.js --out docs/evidencia/videos/disponibilidad.mp4 --title "ESC-DISP-01" \
 *        --cmd "node scripts/load-tests/availability.js" \
 *        --url "http://localhost:3001/d/sitpverse-tecnico?kiosk&refresh=5s&from=now-5m&to=now" --grafana admin:clave
 *
 *   --seconds N   duración máxima (por defecto: hasta que el comando termina, más 6 s)
 *   --width / --height   tamaño del video (1920x1080)
 *   --env "A=1,B=2"      variables de entorno para el comando
 *
 * Requiere Edge o Chrome y ffmpeg (winget install Gyan.FFmpeg). No instala nada.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const out = option('out');
const cmd = option('cmd');
const url = option('url');
const title = option('title', 'SitpVerse');
const grafana = option('grafana');
const width = Number(option('width', 1920));
const height = Number(option('height', 1080));
const maxSeconds = option('seconds') ? Number(option('seconds')) : undefined;
const extraEnv = Object.fromEntries((option('env', '') || '').split(',').filter(Boolean).map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
if (!out || (!cmd && !url)) {
  console.error('uso: node scripts/evidence/record.js --out video.mp4 [--cmd "..."] [--url URL] [--grafana u:c] [--title T] [--seconds N]');
  process.exit(2);
}

const firstExisting = (candidates) => candidates.filter(Boolean).find((candidate) => fs.existsSync(candidate));
const browser = firstExisting([
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]);
/** ffmpeg instalado con winget queda en una carpeta con la versión en el nombre: se busca ahí. */
function wingetFfmpeg() {
  const packages = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft/WinGet/Packages');
  try {
    for (const pack of fs.readdirSync(packages).filter((name) => name.startsWith('Gyan.FFmpeg'))) {
      for (const build of fs.readdirSync(path.join(packages, pack))) {
        const candidate = path.join(packages, pack, build, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch { /* no hay winget */ }
  return undefined;
}
const ffmpeg = firstExisting([
  process.env.FFMPEG_PATH,
  path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft/WinGet/Links/ffmpeg.exe'),
  wingetFfmpeg(),
  '/usr/bin/ffmpeg',
]) ?? 'ffmpeg';
if (!browser) {
  console.error('No se encontró Edge ni Chrome (define BROWSER_PATH)');
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeHtml = (text) => text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

const PAGE = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; display: flex; flex-direction: column; background: #0b0f17; color: #e5e7eb; font-family: "Segoe UI", system-ui, sans-serif; overflow: hidden; }
  header { display: flex; align-items: center; gap: 14px; padding: 10px 18px; background: #111827; border-bottom: 1px solid #1f2937; font-size: 18px; font-weight: 600; }
  header .dot { width: 10px; height: 10px; border-radius: 50%; background: #ef4444; animation: blink 1.2s infinite; }
  header .clock { margin-left: auto; font-variant-numeric: tabular-nums; color: #9ca3af; font-weight: 400; font-size: 15px; }
  @keyframes blink { 50% { opacity: .25; } }
  main { flex: 1; display: flex; min-height: 0; }
  .terminal { flex: ${url ? '0 0 46%' : '1'}; display: flex; flex-direction: column; min-width: 0; border-right: 1px solid #1f2937; }
  .bar { padding: 7px 14px; background: #0f172a; color: #94a3b8; font: 13px Consolas, monospace; border-bottom: 1px solid #1f2937; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  pre { flex: 1; margin: 0; padding: 12px 14px; overflow: hidden; font: ${url ? 13 : 16}px/1.45 Consolas, "Cascadia Mono", monospace; white-space: pre-wrap; word-break: break-word; display: flex; flex-direction: column; justify-content: flex-end; }
  pre span { display: block; }
  .pass { color: #4ade80; } .fail { color: #f87171; font-weight: 700; } .cmd { color: #fbbf24; font-weight: 700; } .ok { color: #22d3ee; font-weight: 700; } .dim { color: #94a3b8; }
  iframe { flex: 1; border: 0; background: #111217; }
</style></head><body>
<header><span class="dot"></span>${escapeHtml(title)}<span class="clock" id="clock"></span></header>
<main>
  ${cmd ? `<section class="terminal"><div class="bar">$ ${escapeHtml(cmd)}</div><pre id="out"></pre></section>` : ''}
  ${url ? `<iframe src="${url.replace(/"/g, '&quot;')}"></iframe>` : ''}
</main>
<script>
  const out = document.getElementById('out');
  const started = Date.now();
  setInterval(() => { const s = Math.floor((Date.now() - started) / 1000); document.getElementById('clock').textContent = new Date().toLocaleTimeString('es-CO') + '  ·  +' + String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }, 250);
  if (out) {
    const source = new EventSource('/stream');
    source.onmessage = (message) => {
      const line = JSON.parse(message.data);
      const span = document.createElement('span');
      span.textContent = line || ' ';
      span.className = /^PASS|^OK /.test(line) ? 'pass' : /^FAIL|FUERA|FALLARON/.test(line) ? 'fail' : /^>>>/.test(line) ? 'cmd' : /^TODO OK/.test(line) ? 'ok' : /^\\s*$|^—|^ESC-/.test(line) ? 'dim' : '';
      out.appendChild(span);
      while (out.childNodes.length > 400) out.removeChild(out.firstChild);
    };
  }
</script></body></html>`;

async function main() {
  // ───── Servidor local: la página y el flujo de líneas de la terminal ─────
  const clients = new Set();
  const backlog = [];
  const push = (line) => {
    backlog.push(line);
    for (const client of clients) client.write(`data: ${JSON.stringify(line)}\n\n`);
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      for (const line of backlog) res.write(`data: ${JSON.stringify(line)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const pageUrl = `http://localhost:${server.address().port}/`;

  // ───── Navegador ─────
  const port = 9300 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sitpverse-rec-'));
  const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'sitpverse-frames-'));
  const chrome = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, `--window-size=${width},${height}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: 'ignore' });
  let child;
  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200);
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((page) => page.type === 'page'); } catch { /* arrancando */ }
    }
    if (!target) throw new Error('el navegador no abrió el puerto de depuración');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('no se pudo conectar al navegador')); });
    let nextId = 0;
    const pending = new Map();
    const shots = []; // { file, at }
    socket.onmessage = (message) => {
      const data = JSON.parse(message.data);
      if (data.method === 'Page.screencastFrame') {
        const file = path.join(frames, `f${String(shots.length).padStart(6, '0')}.jpg`);
        fs.writeFileSync(file, Buffer.from(data.params.data, 'base64'));
        shots.push({ file, at: data.params.metadata.timestamp });
        socket.send(JSON.stringify({ id: ++nextId, method: 'Page.screencastFrameAck', params: { sessionId: data.params.sessionId } }));
        return;
      }
      if (data.id && pending.has(data.id)) {
        const { resolve, reject } = pending.get(data.id);
        pending.delete(data.id);
        data.error ? reject(new Error(data.error.message)) : resolve(data.result);
      }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

    if (grafana && url) {
      const [user, password] = [grafana.slice(0, grafana.indexOf(':')), grafana.slice(grafana.indexOf(':') + 1)];
      await send('Page.navigate', { url: `${new URL(url).origin}/login` });
      await sleep(3000);
      const login = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true,
        expression: `fetch('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: ${JSON.stringify(user)}, password: ${JSON.stringify(password)} }) }).then((r) => r.status)` });
      if (login.result.value !== 200) throw new Error(`Grafana rechazó el inicio de sesión (${login.result.value})`);
    }

    await send('Page.navigate', { url: pageUrl });
    await sleep(url ? 6000 : 1000); // que cargue el tablero antes de empezar
    // Un cuadro cada 250 ms (4 por segundo), pedido por nosotros: no depende de que el navegador decida enviar cuadros,
    // que bajo carga deja de hacerlo.
    const startedAt = Date.now();
    let recording = true;
    const grabber = (async () => {
      while (recording) {
        const tick = Date.now();
        try {
          const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
          const file = path.join(frames, `f${String(shots.length).padStart(6, '0')}.jpg`);
          fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
          shots.push({ file, at: tick / 1000 });
        } catch { /* un cuadro perdido no detiene la grabación */ }
        await sleep(Math.max(0, 250 - (Date.now() - tick)));
      }
    })();

    // ───── El comando, en vivo ─────
    let finished = !cmd;
    if (cmd) {
      push(`$ ${cmd}`);
      child = spawn(cmd, { shell: true, env: { ...process.env, ...extraEnv, FORCE_COLOR: '0' } });
      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) { push(line); console.log(line); }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('close', (code) => { if (buffer) push(buffer); push(''); push(`[el comando terminó con código ${code}]`); finished = true; });
    }

    let tail;
    while (true) {
      await sleep(500);
      const elapsed = (Date.now() - startedAt) / 1000;
      if (maxSeconds && elapsed >= maxSeconds) break;
      if (finished && !maxSeconds) { tail ??= Date.now(); if (Date.now() - tail > 6000) break; }
    }
    recording = false;
    await grabber;
    const endedAt = shots.length ? shots[shots.length - 1].at + 1 : 0;
    socket.close();

    // ───── Video: cada cuadro dura hasta el siguiente ─────
    if (shots.length < 2) throw new Error('no se capturaron cuadros');
    const list = shots.map((shot, i) => `file '${shot.file.replace(/\\/g, '/')}'\nduration ${Math.max(0.04, (shots[i + 1]?.at ?? endedAt) - shot.at).toFixed(3)}`).join('\n') + `\nfile '${shots[shots.length - 1].file.replace(/\\/g, '/')}'\n`;
    const listFile = path.join(frames, 'frames.txt');
    fs.writeFileSync(listFile, list);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    const encode = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', 'fps=12,scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.resolve(out)], { encoding: 'utf8' });
    if (encode.status !== 0) throw new Error(`ffmpeg falló: ${(encode.stderr || encode.error?.message || '').slice(-400)}`);
    console.log(`\nvideo guardado: ${out}  (${((Date.now() - startedAt) / 1000).toFixed(0)} s, ${shots.length} cuadros, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
  } finally {
    child?.kill();
    chrome.kill();
    server.close();
    await sleep(400);
    for (const folder of [profile, frames]) {
      try { fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* carpeta temporal */ }
    }
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(`No se pudo grabar: ${error.message}`);
  process.exit(1);
});
