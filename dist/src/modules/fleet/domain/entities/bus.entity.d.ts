import { BusStatus } from '../value-objects/bus-status.enum';
export interface BusProps {
    id: string;
    plate: string;
    route: string;
    driver?: string | null;
    status: BusStatus;
    latitude?: number | null;
    longitude?: number | null;
    updatedAt: Date;
}
export declare class Bus {
    private props;
    private constructor();
    static fromPersistence(props: BusProps): Bus;
    get id(): string;
    get plate(): string;
    get route(): string;
    get driver(): string | null;
    get status(): BusStatus;
    get latitude(): number | null;
    get longitude(): number | null;
    get updatedAt(): Date;
    startTrip(): void;
    updatePosition(latitude: number, longitude: number): void;
    finishTrip(): void;
    toPersistence(): BusProps;
}
export declare class BusNotInServiceError extends Error {
    constructor(plate: string);
}
export declare class BusAlreadyInServiceError extends Error {
    constructor(plate: string);
}
