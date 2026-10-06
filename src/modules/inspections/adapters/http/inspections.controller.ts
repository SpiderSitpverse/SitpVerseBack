import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AuthenticatedUser, CurrentUser, Roles } from '../../../identity/public';
import {
  CreateInspectionUseCase,
  GetLatestInspectionUseCase,
  ListInspectionsUseCase,
} from '../../application/use-cases/inspections.use-cases';

export class CreateInspectionDto {
  @IsUUID() busId: string;
  /** Nota de la inspección (obligatoria). */
  @IsString() @MaxLength(2000) note: string;
  @IsOptional() @IsString() @MaxLength(2000) comment?: string;
  /** URLs devueltas por `POST /files/images`. */
  @IsOptional() @IsArray() @ArrayMaxSize(10) photos?: string[];
}

export class ListInspectionsDto {
  @IsOptional() @IsUUID() busId?: string;
  @IsOptional() @IsString() @MaxLength(80) inspector?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) take?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) skip?: number;
}

/** Inspección digital previa al viaje, con fotos (Épica 3). */
@Controller('inspections')
export class InspectionsController {
  constructor(
    private readonly create: CreateInspectionUseCase,
    private readonly latest: GetLatestInspectionUseCase,
    private readonly list: ListInspectionsUseCase,
  ) {}

  /** El conductor registra la inspección de su bus (el admin puede registrar la de cualquiera). */
  @Post()
  @Roles('DRIVER', 'ADMIN')
  register(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateInspectionDto) {
    return this.create.execute(user, body);
  }

  /** La inspección más reciente de un bus. 404 si nunca se inspeccionó. */
  @Get('buses/:busId/latest')
  @Roles('ADMIN', 'MECHANICAL', 'DRIVER')
  latestOfBus(@CurrentUser() user: AuthenticatedUser, @Param('busId', ParseUUIDPipe) busId: string) {
    return this.latest.execute(user, busId);
  }

  /** Historial filtrable: `?busId=&inspector=&from=&to=&take=&skip=`. */
  @Get()
  @Roles('ADMIN', 'MECHANICAL')
  history(@Query() query: ListInspectionsDto) {
    return this.list.execute({
      busId: query.busId,
      inspector: query.inspector,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      take: query.take ?? 50,
      skip: query.skip ?? 0,
    });
  }
}
