import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { ListBusesUseCase } from '../../application/use-cases/list-buses.use-case';
import { GetBusDetailUseCase } from '../../application/use-cases/get-bus-detail.use-case';
import { StartTripUseCase } from '../../application/use-cases/start-trip.use-case';
import { UpdateBusPositionUseCase } from '../../application/use-cases/update-bus-position.use-case';
import { FinishTripUseCase } from '../../application/use-cases/finish-trip.use-case';
import { ListBusesDto } from '../../application/dtos/list-buses.dto';
import { UpdatePositionDto } from '../../application/dtos/update-position.dto';

/**
 * Adapter (driving adapter): traduce HTTP -> llamadas a los casos de uso.
 * No tiene lógica de negocio, solo orquesta entrada/salida.
 */
@Controller('fleet/buses')
export class FleetController {
  constructor(
    private readonly listBuses: ListBusesUseCase,
    private readonly getBusDetail: GetBusDetailUseCase,
    private readonly startTrip: StartTripUseCase,
    private readonly updatePosition: UpdateBusPositionUseCase,
    private readonly finishTrip: FinishTripUseCase,
  ) {}

  /** HU-12 / HU-14 */
  @Get()
  findAll(@Query() query: ListBusesDto) {
    return this.listBuses.execute(query.status);
  }

  /** HU-13 */
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.getBusDetail.execute(id);
  }

  /** HU-49 (parte 1) */
  @Patch(':id/start-trip')
  start(@Param('id') id: string) {
    return this.startTrip.execute(id);
  }

  /** HU-49 (parte 2) — este endpoint es el que dispara el evento realtime */
  @Patch(':id/position')
  updatePos(@Param('id') id: string, @Body() body: UpdatePositionDto) {
    return this.updatePosition.execute(id, body.latitude, body.longitude);
  }

  /** HU-51 */
  @Patch(':id/finish-trip')
  finish(@Param('id') id: string) {
    return this.finishTrip.execute(id);
  }
}
