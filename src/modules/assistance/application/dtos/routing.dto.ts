import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateBlockageDto {
  @IsUUID() busId: string;
  @IsString() type: string;
  @IsOptional() @IsString() description?: string;
}

export class AssignTowDto {
  @IsUUID() incidentId: string;
  @IsString() @IsNotEmpty() @MaxLength(60) towTruck: string;
  @IsString() @IsNotEmpty() @MaxLength(60) crew: string;
}

export class AssignTowRequestDto {
  @IsString() @IsNotEmpty() @MaxLength(60) towTruck: string;
  @IsString() @IsNotEmpty() @MaxLength(60) crew: string;
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
  @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  /** Lista de puntos `[latitud, longitud]`. La forma de cada punto la valida `parseRouteGeometry`. */
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(2000) geometry: unknown[];
}

export class AssignAlternativeRouteDto {
  @IsUUID() routeId: string;
  @IsUUID() driverId: string;
}

export class AssignAlternativeRouteRequestDto {
  @IsUUID() driverId: string;
}
