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
import { AuthenticatedUser, AuthenticateTokenUseCase } from '../../modules/identity/public';
import type { BusPositionEvent } from '../../modules/fleet/public';
import { MetricsService } from '../../shared/infrastructure/metrics.service';

/** Quién ve el mapa de la flota en tiempo real: administración y mecánicos (el conductor no). */
const FLEET_MAP_ROLES = ['ADMIN', 'MECHANICAL'];

/**
 * Único punto de salida WebSocket (namespace `/realtime`). Sin lógica de negocio:
 * solo reenvía lo que le entregan los consumidores de Redis.
 *
 *  - Posiciones de flota → solo a administradores y mecánicos autenticados.
 *  - Alertas → solo a las salas de su audiencia (`role:X`, `user:Y`).
 *
 * Un cliente se autentica con `io(url + '/realtime', { auth: { token, lastSeq } })`, donde
 * `token` es el `accessToken` de `POST /auth/login`. Sin token válido se le desconecta.
 * `lastSeq` (opcional) es el mayor `seq` que ya vio: al reconectarse el servidor le
 * REPRODUCE las alertas que ocurrieron mientras estuvo desconectado.
 * El CORS lo define RealtimeIoAdapter.
 */
@WebSocketGateway({ namespace: 'realtime' })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly authenticate: AuthenticateTokenUseCase,
    private readonly outbox: OutboxReader,
    private readonly metrics: MetricsService,
  ) {}

  async handleConnection(client: Socket) {
    const { token, lastSeq } = this.credentialsOf(client);
    try {
      const user = await this.authenticate.execute(token);
      if (!user) {
        this.logger.warn(`Conexión rechazada (token ausente o inválido): ${client.id}`);
        client.emit(SOCKET_EVENTS.UNAUTHORIZED, { message: 'Token ausente, inválido o vencido' });
        client.disconnect(true);
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
    this.server.to(FLEET_MAP_ROLES.map(roleRoom)).emit(SOCKET_EVENTS.FLEET_POSITION, event);
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

  /** El token solo se acepta en `auth` (no en la URL, donde quedaría en los logs de los proxies). */
  private credentialsOf(client: Socket): { token?: string; lastSeq?: bigint } {
    const auth = client.handshake.auth ?? {};
    const lastSeq = String(auth.lastSeq ?? '');
    return {
      token: typeof auth.token === 'string' ? auth.token : undefined,
      lastSeq: /^\d+$/.test(lastSeq) ? BigInt(lastSeq) : undefined,
    };
  }
}
