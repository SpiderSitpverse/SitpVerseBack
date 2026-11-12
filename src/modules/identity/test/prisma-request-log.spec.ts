import { Logger } from '@nestjs/common';
import { runWithRequestContext } from '../../../shared/http/client-info';
import { RequestRecord } from '../../../shared/domain/request-sink.port';
import { auditData } from '../infrastructure/prisma/prisma-audit-log';
import { PrismaRequestLog } from '../infrastructure/prisma/prisma-request-log';

Logger.overrideLogger(false);

const record = (n: number): RequestRecord => ({
  at: new Date(1000 + n), traceId: `t-${n}`, method: 'GET', path: `/p/${n}`, status: 200, durationMs: 5,
  ip: '1.2.3.4', country: 'CO', userAgent: 'UA', userId: null, role: null,
});

function build() {
  const created: unknown[][] = [];
  const state = { fail: false };
  const prisma = {
    requestLog: {
      createMany: jest.fn(async ({ data }: { data: unknown[] }) => {
        if (state.fail) throw new Error('base caída');
        created.push(data);
      }),
      findMany: jest.fn(async () => [{ ...record(1), id: BigInt(7), at: new Date(1001) }]),
    },
  };
  const log = new PrismaRequestLog(prisma as never);
  return { log, prisma, created, state };
}

describe('Registro de peticiones en la base (por lotes)', () => {
  it('no escribe petición por petición: junta y guarda el lote al vaciarlo', async () => {
    const t = build();
    for (let i = 0; i < 5; i++) t.log.push(record(i));
    expect(t.prisma.requestLog.createMany).not.toHaveBeenCalled();
    await t.log.flush();
    expect(t.created).toHaveLength(1);
    expect(t.created[0]).toHaveLength(5);
  });

  it('al llegar a 200 pendientes guarda sin esperar al temporizador', async () => {
    const t = build();
    for (let i = 0; i < 200; i++) t.log.push(record(i));
    await t.log.flush();
    expect(t.created.flat()).toHaveLength(200);
  });

  it('al apagar el servidor vacía lo pendiente', async () => {
    const t = build();
    t.log.push(record(1));
    await t.log.onModuleDestroy();
    expect(t.created.flat()).toHaveLength(1);
  });

  it('si la base falla, no se pierde: el lote vuelve a la cola y se guarda en el siguiente intento', async () => {
    const t = build();
    t.state.fail = true;
    t.log.push(record(1));
    await t.log.flush();
    expect(t.created).toHaveLength(0);
    t.state.fail = false;
    t.log.push(record(2));
    await t.log.flush();
    expect(t.created.flat().map((r) => (r as RequestRecord).traceId)).toEqual(['t-1', 't-2']);
  });

  it('con la base caída mucho tiempo solo retiene los 5000 más recientes (no agota la memoria)', async () => {
    const t = build();
    t.state.fail = true;
    for (let i = 0; i < 5100; i++) t.log.push(record(i));
    await t.log.flush();
    t.state.fail = false;
    await t.log.flush();
    const saved = t.created.flat() as RequestRecord[];
    expect(saved).toHaveLength(5000);
    expect(saved[0].traceId).toBe('t-100');
  });

  it('consultar primero vacía lo pendiente (lo que acaba de pasar ya aparece) y devuelve ids de texto', async () => {
    const t = build();
    t.log.push(record(1));
    const rows = await t.log.list({ limit: 10, path: '/fleet', userId: 'u1' });
    expect(t.created).toHaveLength(1);
    expect(rows[0].id).toBe('7');
    expect(t.prisma.requestLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10, orderBy: { at: 'desc' }, where: expect.objectContaining({ userId: 'u1', path: { startsWith: '/fleet' } }) }),
    );
  });

  it('el temporizador guarda cada segundo y no mantiene vivo el proceso', async () => {
    jest.useFakeTimers();
    try {
      const t = build();
      t.log.onModuleInit();
      t.log.push(record(1));
      await jest.advanceTimersByTimeAsync(1100);
      expect(t.created.flat()).toHaveLength(1);
      await t.log.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('auditData toma IP, país, navegador y trace_id de la petición en curso', () => {
  it('sin que el caso de uso los pase', () => {
    const data = runWithRequestContext(
      { traceId: 'trace-1', ip: '190.250.10.1', country: 'CO', userAgent: 'Chrome' },
      () => auditData({ action: 'user.update', outcome: 'SUCCESS' }),
    );
    expect(data).toMatchObject({ ip: '190.250.10.1', country: 'CO', userAgent: 'Chrome', traceId: 'trace-1' });
  });

  it('lo que la entrada trae explícito manda sobre el contexto; fuera de una petición queda vacío', () => {
    const explicit = runWithRequestContext(
      { traceId: 'trace-1', ip: '1.1.1.1', country: 'US', userAgent: 'X' },
      () => auditData({ action: 'a', outcome: 'SUCCESS', ip: '9.9.9.9', country: 'CO' }),
    );
    expect(explicit).toMatchObject({ ip: '9.9.9.9', country: 'CO', userAgent: 'X' });
    expect(auditData({ action: 'a', outcome: 'SUCCESS' })).toMatchObject({ ip: null, country: null, userAgent: null, traceId: null });
  });
});
