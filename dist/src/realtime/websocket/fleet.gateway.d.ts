import { OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { BusPositionEvent } from '../../modules/fleet/domain/ports/position-publisher.port';
export declare const FLEET_POSITION_EVENT = "fleet:position-updated";
export declare class FleetGateway implements OnGatewayConnection, OnGatewayDisconnect {
    private readonly logger;
    server: Server;
    handleConnection(client: Socket): void;
    handleDisconnect(client: Socket): void;
    broadcastPositionUpdate(event: BusPositionEvent): void;
}
