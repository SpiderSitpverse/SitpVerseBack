import { ConfigService } from '@nestjs/config';
import { RealtimeGateway } from '../websocket/realtime.gateway';
import { MetricsService } from '../../shared/infrastructure/metrics.service';
import { SOCKET_EVENTS } from '../../shared/contracts/realtime.contract';

interface Emission {
  rooms: string[];
  except: string[];
  event: string;
  payload: unknown;
}

/** Servidor Socket.IO falso: registra a qué salas se emite, qué salas se excluyen y qué se envía. */
function fakeServer() {
  const emissions: Emission[] = [];
  const server = {
    to: (rooms: string | string[]) => {
      const target = { rooms: ([] as string[]).concat(rooms), except: [] as string[] };
      const chain = {
        except: (room: string) => {
          target.except.push(room);
          return chain;
        },
        emit: (event: string, payload: unknown) => void emissions.push({ ...target, event, payload }),
      };
      return chain;
    },
  };
  return { server, emissions };
}

const position = (busId: string, latitude: number) =>
  ({ busId, plate: busId, route: 'R', status: 'IN_SERVICE', latitude, longitude: -74.1, updatedAt: new Date().toISOString() }) as never;

function build(batchMs = 250) {
  jest.useFakeTimers();
  const gateway = new RealtimeGateway({} as never, {} as never, new MetricsService(), { get: (_k: string, d: number) => batchMs ?? d } as unknown as ConfigService);
  const { server, emissions } = fakeServer();
  gateway.server = server as never;
  return { gateway, emissions };
}

describe('RealtimeGateway · posiciones agrupadas', () => {
  afterEach(() => jest.useRealTimers());

  it('cada posición llega al instante a los clientes que NO piden lotes (compatibilidad), nunca a los de lote', () => {
    const { gateway, emissions } = build();
    gateway.broadcastPositionUpdate(position('b1', 4.6));
    const individual = emissions.filter((e) => e.event === SOCKET_EVENTS.FLEET_POSITION);
    expect(individual).toHaveLength(1);
    expect(individual[0].rooms.sort()).toEqual(['role:ADMIN', 'role:MECHANICAL']);
    expect(individual[0].except).toEqual(['fleet:batch']);
  });

  it('los de lote reciben la ÚLTIMA posición de cada bus, en un solo mensaje, pasado el intervalo', () => {
    const { gateway, emissions } = build(250);
    gateway.broadcastPositionUpdate(position('b1', 4.6));
    gateway.broadcastPositionUpdate(position('b2', 4.7));
    gateway.broadcastPositionUpdate(position('b1', 4.61)); // reemplaza a la anterior de b1
    expect(emissions.filter((e) => e.event === SOCKET_EVENTS.FLEET_POSITIONS_BATCH)).toHaveLength(0);

    jest.advanceTimersByTime(250);

    const batches = emissions.filter((e) => e.event === SOCKET_EVENTS.FLEET_POSITIONS_BATCH);
    expect(batches).toHaveLength(1);
    expect(batches[0].rooms).toEqual(['fleet:batch']);
    const sent = batches[0].payload as { busId: string; latitude: number }[];
    expect(sent.map((p) => [p.busId, p.latitude])).toEqual([['b1', 4.61], ['b2', 4.7]]);
  });

  it('un solo temporizador por intervalo y sin mensajes vacíos', () => {
    const { gateway, emissions } = build(100);
    for (let i = 0; i < 50; i++) gateway.broadcastPositionUpdate(position(`b${i % 5}`, 4.6 + i / 1000));
    jest.advanceTimersByTime(100);
    jest.advanceTimersByTime(1000); // sin nuevas posiciones: no se envía nada más
    expect(emissions.filter((e) => e.event === SOCKET_EVENTS.FLEET_POSITIONS_BATCH)).toHaveLength(1);
    expect((emissions.find((e) => e.event === SOCKET_EVENTS.FLEET_POSITIONS_BATCH)!.payload as unknown[]).length).toBe(5);
  });

  it('al apagar la instancia se cancela el temporizador', () => {
    const { gateway, emissions } = build();
    gateway.broadcastPositionUpdate(position('b1', 4.6));
    gateway.onModuleDestroy();
    jest.advanceTimersByTime(1000);
    expect(emissions.filter((e) => e.event === SOCKET_EVENTS.FLEET_POSITIONS_BATCH)).toHaveLength(0);
  });
});
