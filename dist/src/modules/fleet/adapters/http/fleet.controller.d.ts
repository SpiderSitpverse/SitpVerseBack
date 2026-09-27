import { ListBusesUseCase } from '../../application/use-cases/list-buses.use-case';
import { GetBusDetailUseCase } from '../../application/use-cases/get-bus-detail.use-case';
import { StartTripUseCase } from '../../application/use-cases/start-trip.use-case';
import { UpdateBusPositionUseCase } from '../../application/use-cases/update-bus-position.use-case';
import { FinishTripUseCase } from '../../application/use-cases/finish-trip.use-case';
import { ListBusesDto } from '../../application/dtos/list-buses.dto';
import { UpdatePositionDto } from '../../application/dtos/update-position.dto';
export declare class FleetController {
    private readonly listBuses;
    private readonly getBusDetail;
    private readonly startTrip;
    private readonly updatePosition;
    private readonly finishTrip;
    constructor(listBuses: ListBusesUseCase, getBusDetail: GetBusDetailUseCase, startTrip: StartTripUseCase, updatePosition: UpdateBusPositionUseCase, finishTrip: FinishTripUseCase);
    findAll(query: ListBusesDto): Promise<import("../../domain/entities/bus.entity").BusProps[]>;
    findOne(id: string): Promise<import("../../domain/entities/bus.entity").BusProps>;
    start(id: string): Promise<import("../../domain/entities/bus.entity").BusProps>;
    updatePos(id: string, body: UpdatePositionDto): Promise<import("../../domain/entities/bus.entity").BusProps>;
    finish(id: string): Promise<import("../../domain/entities/bus.entity").BusProps>;
}
