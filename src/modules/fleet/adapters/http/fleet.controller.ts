import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser, Roles } from '../../../identity/public';
import { BusAccessService } from '../../application/services/bus-access.service';
import { ListBusesUseCase } from '../../application/use-cases/list-buses.use-case';
import { GetBusDetailUseCase } from '../../application/use-cases/get-bus-detail.use-case';
import { StartTripUseCase } from '../../application/use-cases/start-trip.use-case';
import { UpdateBusPositionUseCase } from '../../application/use-cases/update-bus-position.use-case';
import { FinishTripUseCase } from '../../application/use-cases/finish-trip.use-case';
import { ListBusesDto } from '../../application/dtos/list-buses.dto';
import { UpdatePositionDto } from '../../application/dtos/update-position.dto';
import { AssignDriverDto, CreateBusDto, UpdateBusDto } from '../../application/dtos/manage-buses.dto';
import {
  AssignDriverUseCase,
  CreateBusUseCase,
  UpdateBusDetailsUseCase,
} from '../../application/use-cases/manage-buses.use-cases';

/**
 * Adapter (driving adapter): traduce HTTP → casos de uso. Sin lógica de negocio.
 *
 * Acceso (ver `fleet.policy.ts`): el guard global valida el ROL; BusAccessService valida
 * la pertenencia (un DRIVER solo toca su propio bus).
 */
@Controller('fleet/buses')
export class FleetController {
  constructor(
    private readonly access: BusAccessService,
    private readonly listBuses: ListBusesUseCase,
    private readonly getBusDetail: GetBusDetailUseCase,
    private readonly startTrip: StartTripUseCase,
    private readonly updatePosition: UpdateBusPositionUseCase,
    private readonly finishTrip: FinishTripUseCase,
    private readonly createBus: CreateBusUseCase,
    private readonly updateBus: UpdateBusDetailsUseCase,
    private readonly assignDriver: AssignDriverUseCase,
  ) {}

  /** HU-12 / HU-14 — el conductor solo ve su bus. */
  @Get()
  @Roles('ADMIN', 'MECHANICAL', 'DRIVER')
  findAll(@CurrentUser() user: AuthenticatedUser, @Query() query: ListBusesDto) {
    return this.listBuses.execute(query.status, user.role === 'DRIVER' ? user.id : undefined);
  }

  /** HU-13 */
  @Get(':id')
  @Roles('ADMIN', 'MECHANICAL', 'DRIVER')
  async findOne(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.access.assertCanView(user, id);
    return this.getBusDetail.execute(id);
  }

  /** HU-49 (parte 1) */
  @Patch(':id/start-trip')
  @Roles('ADMIN', 'DRIVER')
  async start(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.access.assertCanOperate(user, id);
    return this.startTrip.execute(id);
  }

  /**
   * HU-49 (parte 2) — dispara el evento realtime. Lo usa la app del conductor; el feed
   * (simulado o real) no pasa por HTTP: llama directo a UpdateBusPositionUseCase.
   */
  @Patch(':id/position')
  @Roles('ADMIN', 'DRIVER')
  async updatePos(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePositionDto,
  ) {
    await this.access.assertCanOperate(user, id);
    return this.updatePosition.execute(id, body.latitude, body.longitude);
  }

  /** HU-51 */
  @Patch(':id/finish-trip')
  @Roles('ADMIN', 'DRIVER')
  async finish(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.access.assertCanOperate(user, id);
    return this.finishTrip.execute(id);
  }

  /** Registro de flota: da de alta un bus nuevo. 409 si la placa ya existe. */
  @Post()
  @Roles('ADMIN')
  create(@Body() body: CreateBusDto) {
    return this.createBus.execute(body);
  }

  /** Registro de flota: edita la ficha del bus (modelo, año, operador, capacidad, referencia). */
  @Patch(':id')
  @Roles('ADMIN')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateBusDto) {
    return this.updateBus.execute(id, body);
  }

  /** Asigna el conductor de un bus (`{ "driverId": "<id>" }`) o lo quita (`{ "driverId": null }`). */
  @Patch(':id/driver')
  @Roles('ADMIN')
  setDriver(@Param('id', ParseUUIDPipe) id: string, @Body() body: AssignDriverDto) {
    return this.assignDriver.execute(id, body.driverId ?? null);
  }
}
