import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';
import { RequestRecord } from '../domain/request-sink.port';
import { currentRequestContext } from '../http/client-info';
import { requestLogger, severityOf } from '../http/request-logger';

interface FakeRes extends EventEmitter {
  statusCode: number;
  headers: Record<string, string>;
  setHeader(name: string, value: string): void;
}

function run(req: Record<string, unknown>, status = 200, clock = [1000, 1042]) {
  const records: RequestRecord[] = [];
  let seen: ReturnType<typeof currentRequestContext>;
  const logs: Record<string, unknown>[] = [];
  const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation((m) => void logs.push(JSON.parse(String(m))));
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation((m) => void logs.push(JSON.parse(String(m))));
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation((m) => void logs.push(JSON.parse(String(m))));
  const res = Object.assign(new EventEmitter(), {
    statusCode: status,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
  }) as FakeRes;
  const next = jest.fn(() => {
    seen = currentRequestContext();
  });
  const ticks = [...clock];
  const middleware = requestLogger({ push: (r) => void records.push(r) }, () => ticks.shift() ?? 0);
  const fullReq = { method: 'GET', originalUrl: '/fleet/buses', ip: '1.2.3.4', header: () => undefined, ...req };
  middleware(fullReq as never, res as never, next);
  res.emit('finish');
  [spy, warn, error].forEach((s) => s.mockRestore());
  return { logs, res, next, req: fullReq, records, seen: () => seen };
}

describe('Registro de peticiones (ESC-OBS-01)', () => {
  it('deja UNA línea JSON por petición con método, ruta, código, duración, IP y trace_id', () => {
    const { logs, res, next } = run({});
    expect(next).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event: 'http.request',
      method: 'GET',
      path: '/fleet/buses',
      status: 200,
      duration_ms: 42,
      ip: '1.2.3.4',
      severity: 'INFO',
      user_id: null,
    });
    expect(res.headers['X-Trace-Id']).toBe(logs[0].trace_id); // el mismo id sale en la respuesta y en el log
  });

  it('cada petición recibe un trace_id distinto', () => {
    const a = run({}).logs[0].trace_id;
    const b = run({}).logs[0].trace_id;
    expect(a).not.toBe(b);
  });

  it('respeta un X-Trace-Id razonable del cliente y descarta uno sospechoso', () => {
    expect(run({ header: () => 'mi-traza-12345' }).logs[0].trace_id).toBe('mi-traza-12345');
    const evil = run({ header: () => 'x\nFORGED {"event":"auth.login"}' }).logs[0].trace_id as string;
    expect(evil).toMatch(/^[0-9a-f-]{36}$/); // se generó uno propio
  });

  it('NO registra la query (puede traer datos) ni cabeceras ni cuerpo', () => {
    const { logs } = run({
      method: 'POST',
      originalUrl: '/auth/google?token=SECRETO',
      headers: { authorization: 'Bearer SECRETO' },
      body: { idToken: 'SECRETO' },
    });
    expect(JSON.stringify(logs)).not.toContain('SECRETO');
    expect(logs[0].path).toBe('/auth/google');
  });

  it('anota quién hizo la petición cuando el guard ya lo identificó', () => {
    const { logs } = run({ user: { id: 'u-1', role: 'ADMIN' } });
    expect(logs[0]).toMatchObject({ user_id: 'u-1', role: 'ADMIN' });
  });

  it.each([
    [200, 'INFO'],
    [404, 'WARN'],
    [429, 'WARN'],
    [500, 'ERROR'],
    [503, 'ERROR'],
  ])('el código %i se registra con gravedad %s', (status, severity) => {
    expect(severityOf(status)).toBe(severity);
    expect(run({}, status).logs[0].severity).toBe(severity);
  });

  it('omite /health y las fotos (ruido)', () => {
    expect(run({ originalUrl: '/health' }).logs).toHaveLength(0);
    expect(run({ originalUrl: '/uploads/abc.jpg' }).logs).toHaveLength(0);
  });

  describe('trazabilidad de todas las peticiones (ESC-SEG-03): hora, IP, usuario, navegador y país', () => {
    const headers: Record<string, string> = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0' };
    const header = (name: string) => headers[name.toLowerCase()];

    it('guarda la hora, la IP, el país, el navegador y el usuario de CADA petición', () => {
      const { records, logs } = run({ ip: '190.250.10.1', header, user: { id: 'u-1', role: 'DRIVER' } });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        at: new Date(1000),
        method: 'GET',
        path: '/fleet/buses',
        status: 200,
        durationMs: 42,
        ip: '190.250.10.1',
        country: 'CO',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0',
        userId: 'u-1',
        role: 'DRIVER',
      });
      expect(logs[0]).toMatchObject({ country: 'CO', user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0' });
    });

    it('también guarda las rechazadas y las de quien no inició sesión (usuario vacío)', () => {
      const denied = run({ ip: '8.8.8.8', header }, 401).records[0];
      expect(denied).toMatchObject({ status: 401, userId: null, role: null, country: 'US' });
      expect(run({ ip: '8.8.8.8', header }, 429).records[0].status).toBe(429);
    });

    it('detrás del proxy de Azure la IP llega con puerto o mapeada a IPv6: se guarda limpia', () => {
      expect(run({ ip: '190.250.10.1:51234', header }).records[0].ip).toBe('190.250.10.1');
      expect(run({ ip: '::ffff:190.250.10.1', header }).records[0].ip).toBe('190.250.10.1');
    });

    it('una IP privada no tiene país; sin User-Agent queda vacío; uno con saltos de línea se limpia y se recorta', () => {
      expect(run({ ip: '127.0.0.1', header }).records[0].country).toBeNull();
      expect(run({ header: () => undefined }).records[0].userAgent).toBeNull();
      const hostile = run({ header: () => `Bot\r\nFORGED {"x":1}${'a'.repeat(500)}` }).records[0].userAgent!;
      expect(hostile).not.toMatch(/[\r\n]/);
      expect(hostile.length).toBeLessThanOrEqual(300);
    });

    it('el trabajo de la petición corre dentro de su contexto (la auditoría lee de ahí la IP, el país y el navegador)', () => {
      const { seen, logs } = run({ ip: '190.250.10.1', header });
      expect(seen()).toMatchObject({ ip: '190.250.10.1', country: 'CO', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0', traceId: logs[0].trace_id });
    });

    it('/health y las fotos no se guardan (ruido)', () => {
      expect(run({ originalUrl: '/health' }).records).toHaveLength(0);
    });
  });
});
