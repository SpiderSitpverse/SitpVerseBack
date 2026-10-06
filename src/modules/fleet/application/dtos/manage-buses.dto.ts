import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

export class CreateBusDto {
  @IsString() @MinLength(3) @MaxLength(12) plate: string;
  /** Troncal o ruta del bus. */
  @IsString() @MinLength(1) @MaxLength(80) route: string;
  @IsOptional() @IsString() @MaxLength(80) model?: string;
  @IsOptional() @IsInt() @Min(1980) @Max(2100) year?: number;
  @IsOptional() @IsString() @MaxLength(80) operator?: string;
  @IsOptional() @IsInt() @Min(1) @Max(500) capacity?: number;
  @IsOptional() @IsString() @MaxLength(120) locationLabel?: string;
}

export class UpdateBusDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(12) plate?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) route?: string;
  @IsOptional() @IsString() @MaxLength(80) model?: string;
  @IsOptional() @IsInt() @Min(1980) @Max(2100) year?: number;
  @IsOptional() @IsString() @MaxLength(80) operator?: string;
  @IsOptional() @IsInt() @Min(1) @Max(500) capacity?: number;
  @IsOptional() @IsString() @MaxLength(120) locationLabel?: string;
}

export class AssignDriverDto {
  /** Id del usuario conductor, o `null` para dejar el bus sin conductor. */
  @ValidateIf((o) => o.driverId !== null)
  @IsUUID()
  driverId: string | null;
}
