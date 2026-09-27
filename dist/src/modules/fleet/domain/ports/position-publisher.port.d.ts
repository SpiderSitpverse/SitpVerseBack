export declare const POSITION_PUBLISHER: unique symbol;
export interface BusPositionEvent {
    busId: string;
    plate: string;
    route: string;
    status: string;
    latitude: number;
    longitude: number;
    updatedAt: string;
}
export interface PositionPublisherPort {
    publish(event: BusPositionEvent): Promise<void>;
}
