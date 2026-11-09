import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import {
  AudienceEvent,
  REDIS_STREAMS,
  SOCKET_EVENTS,
  isInAudience,
  roleRoom,
  userRoom,
} from '../../shared/contracts/realtime.contract';
import { OutboxReader } from '../../shared/infrastructure/outbox/outbox.reader';
import { AuthenticatedUser, AuthenticateEmployeeUseCase } from '../../modules/identity/public';
import type { BusPositionEvent } from '../../modules/fleet/public';
import { MetricsService } from '../../shared/infrastructure/metrics.service';

/**
 * Único punto de salida WebSocket (namespace `/realtime`). Sin lógica de negocio:
 * solo reenvía lo que le entregan los consumidores de Redis.
 *
 *  - Posiciones de flota → broadcast a todos los clientes.
 *  - Alertas → solo a las salas de su audiencia (`role:X`, `user:Y`).
 *
 * Un cliente se identifica con `io(url + '/realtime', { auth: { employeeId, lastSeq } })`.
 * `lastSeq` (opcional) es el mayor `seq` que ya vio: al reconectarse el servidor le
 * REPRODUCE las alertas que ocurrieron mientras estuvo desconectado. Sin identificarse
 * recibe flota pero ninguna alerta dirigida. El CORS lo define RealtimeIoAdapter.
 */
@WebSocketGateway({ namespace: 'realtime' })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly authenticate: AuthenticateEmployeeUseCase,
    private readonly outbox: OutboxReader,
    private readonly metrics: MetricsService,
  ) {}

  async handleConnection(client: Socket) {
    const { employeeId, lastSeq } = this.credentialsOf(client);
    try {
      const user = await this.authenticate.execute(employeeId);
      if (!user) {
        this.logger.log(`Cliente anónimo conectado: ${client.id}`);
        return;
      }
      client.join([roleRoom(user.role), userRoom(user.id)]);
      this.metrics.increment('sitpverse_websocket_connections_total', { result: 'identified' });
      client.emit(SOCKET_EVENTS.IDENTIFIED, { role: user.role, name: user.name });
      this.logger.log(`Cliente ${client.id} identificado como ${user.role}`);

      if (lastSeq !== undefined) await this.replayMissed(client, user, lastSeq);
    } catch (err) {
      this.metrics.increment('sitpverse_websocket_connection_errors_total');
      this.logger.error(`No se pudo identificar/reproducir para ${client.id}: ${err}`);
    }
  }

  handleDisconnect(client: Socket) {
    this.metrics.increment('sitpverse_websocket_disconnects_total');
    this.logger.log(`Cliente desconectado: ${client.id}`);
  }

  broadcastPositionUpdate(event: BusPositionEvent) {
    this.metrics.increment('sitpverse_websocket_events_sent_total', { event: 'fleet_position' });
    this.observeEventLatency(event.updatedAt, 'fleet_position');
    this.server.emit(SOCKET_EVENTS.FLEET_POSITION, event);
  }

  broadcastToAudience(event: AudienceEvent) {
    const rooms = [
      ...(event.audience.roles ?? []).map(roleRoom),
      ...(event.audience.userIds ?? []).map(userRoom),
    ];
    if (rooms.length === 0) return;
    const eventType = event.type ?? 'unknown';
    this.metrics.increment('sitpverse_websocket_events_sent_total', { event: eventType });
    this.observeEventLatency(
      typeof event.publishedAt === 'string' ? event.publishedAt : event.occurredAt,
      eventType,
    );
    this.server.to(rooms).emit(SOCKET_EVENTS.ASSISTANCE, event);
  }

  private observeEventLatency(timestamp: string | undefined, event: string) {
    if (!timestamp) return;
    const latencyMs = Date.now() - Date.parse(timestamp);
    if (Number.isFinite(latencyMs) && latencyMs >= 0) {
      this.metrics.observe('sitpverse_realtime_delivery_latency_ms', latencyMs, { event });
    }
  }

  /** Entrega, en orden, las alertas posteriores a `lastSeq` que correspondan a este usuario. */
  private async replayMissed(client: Socket, user: AuthenticatedUser, lastSeq: bigint) {
    const missed = await this.outbox.since(REDIS_STREAMS.ASSISTANCE, lastSeq);
    const mine = missed.filter(
      (e) => e.payload.audience && isInAudience(e.payload.audience, user),
    );
    for (const event of mine) client.emit(SOCKET_EVENTS.ASSISTANCE, event.payload);
    if (mine.length > 0) {
      this.logger.log(`Reproducidos ${mine.length} eventos perdidos a ${client.id}`);
    }
  }

  private credentialsOf(client: Socket): { employeeId?: string; lastSeq?: bigint } {
    const source = { ...client.handshake.query, ...client.handshake.auth };
    const lastSeq = String(source.lastSeq ?? '');
    return {
      employeeId: typeof source.employeeId === 'string' ? source.employeeId : undefined,
      lastSeq: /^\d+$/.test(lastSeq) ? BigInt(lastSeq) : undefined,
    };
  }
}
