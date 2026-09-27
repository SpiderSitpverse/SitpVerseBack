import { IsEnum, IsOptional } from 'class-validator';
import { BusStatus } from '../../domain/value-objects/bus-status.enum';

export class ListBusesDto {
  @IsOptional()
  @IsEnum(BusStatus)
  status?: BusStatus;
}
