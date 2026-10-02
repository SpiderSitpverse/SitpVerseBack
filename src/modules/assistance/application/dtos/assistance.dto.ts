import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class ReportIncidentDto {
  @IsUUID() busId: string;
  @IsString() type: string;
  @IsOptional() @IsString() description?: string;
}

export class SupportCallDto {
  /** Cantidad de buses/conductores necesarios. */
  @IsInt() @Min(1) @Max(50) slots: number;
  @IsInt() @Min(0) rewardPoints: number;
}

export class BusFaultDto {
  @IsUUID() busId: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsInt() @Min(0) rewardPoints?: number;
}

export class ListCallsDto {
  @IsOptional() @IsEnum(['OPEN', 'FILLED', 'COMPLETED'])
  status?: 'OPEN' | 'FILLED' | 'COMPLETED';
}
