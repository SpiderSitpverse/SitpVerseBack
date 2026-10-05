import { IsArray, IsEnum, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateBlockageDto {
  @IsUUID() busId: string;
  @IsString() type: string;
  @IsOptional() @IsString() description?: string;
}

export class AssignTowDto {
  @IsUUID() incidentId: string;
  @IsString() towTruck: string;
  @IsString() crew: string;
}

export class AssignTowRequestDto {
  @IsString() towTruck: string;
  @IsString() crew: string;
}

export class AttachIncidentEvidenceDto {
  /** URL de la fotografía en el almacenamiento de archivos. */
  @IsString() url: string;
  @IsOptional() @IsString() caption?: string;
  @IsOptional() @IsISO8601() capturedAt?: string;
}

export class ListTowReportsDto {
  @IsOptional() @IsString() towTruck?: string;
  @IsOptional() @IsString() crew?: string;
  @IsOptional() @IsUUID() incidentId?: string;
  @IsOptional() @IsEnum(['ASSIGNED', 'IN_PROGRESS', 'COMPLETED'])
  status?: 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED';
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) skip = 0;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) take = 50;
}

export class CreateAlternativeRouteDto {
  @IsString() name: string;
  @IsArray() geometry: unknown[];
}

export class AssignAlternativeRouteDto {
  @IsUUID() routeId: string;
  @IsUUID() driverId: string;
}

export class AssignAlternativeRouteRequestDto {
  @IsUUID() driverId: string;
}
