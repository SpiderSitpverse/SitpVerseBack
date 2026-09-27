import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { BusPositionEvent } from '../../modules/fleet/domain/ports/position-publisher.port';

export const FLEET_POSITION_EVENT = 'fleet:position-updated';

/**
 * Realtime Gateway del diagrama de arquitectura.
 * No tiene lógica de negocio: solo expone la conexión WebSocket al frontend
 * y reenvía lo que el RedisSubscriberService le entrega.
 *
 * Namespace: /realtime  (en el front: io("http://localhost:3000/realtime"))
 */
@WebSocketGateway({
  namespace: 'realtime',
  cors: { origin: process.env.CORS_ORIGIN ?? '*' },
})
export class FleetGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(FleetGateway.name);

  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket) {
    this.logger.log(`Cliente conectado: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Cliente desconectado: ${client.id}`);
  }

  /** Llamado por RedisSubscriberService cuando llega un evento de Redis. */
  broadcastPositionUpdate(event: BusPositionEvent) {
    this.server.emit(FLEET_POSITION_EVENT, event);
  }
}
