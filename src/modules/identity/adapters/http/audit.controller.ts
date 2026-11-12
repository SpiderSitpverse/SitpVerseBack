import { Controller, Get, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ListAuditUseCase, ListRequestLogUseCase } from '../../application/list-audit.use-case';
import { Roles } from './auth.decorators';

export class AuditQueryDto {
  @IsOptional() @IsString() @MaxLength(64) action?: string;
  @IsOptional() @IsString() @MaxLength(64) actorId?: string;
  @IsOptional() @IsString() @MaxLength(64) resourceType?: string;
  @IsOptional() @IsString() @MaxLength(64) resourceId?: string;
  @IsOptional() @IsEnum(['SUCCESS', 'DENIED', 'FAILURE']) outcome?: 'SUCCESS' | 'DENIED' | 'FAILURE';
  @IsOptional() @Type(() => Date) @IsDate() from?: Date;
  @IsOptional() @Type(() => Date) @IsDate() to?: Date;
  /** Paginación: solo registros anteriores a esta fecha (use el `at` del último registro recibido). */
  @IsOptional() @Type(() => Date) @IsDate() before?: Date;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

export class RequestLogQueryDto {
  @IsOptional() @IsString() @MaxLength(64) userId?: string;
  @IsOptional() @IsString() @MaxLength(64) ip?: string;
  @IsOptional() @IsString() @MaxLength(2) country?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(100) @Max(599) status?: number;
  @IsOptional() @IsString() @MaxLength(200) path?: string;
  @IsOptional() @Type(() => Date) @IsDate() from?: Date;
  @IsOptional() @Type(() => Date) @IsDate() to?: Date;
  @IsOptional() @Type(() => Date) @IsDate() before?: Date;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

/**
 * ESC-SEG-03: consulta de la auditoría. Solo ADMIN y SOLO LECTURA: no existe ninguna ruta que modifique o borre
 * registros (y la base de datos los rechaza aunque alguien lo intentara).
 */
@Controller('audit')
export class AuditController {
  constructor(
    private readonly listAudit: ListAuditUseCase,
    private readonly listRequests: ListRequestLogUseCase,
  ) {}

  /** Registros más recientes primero. Filtros: `action`, `actorId`, `resourceType`, `resourceId`, `outcome`, `from`, `to`. */
  @Get()
  @Roles('ADMIN')
  list(@Query() query: AuditQueryDto) {
    return this.listAudit.execute(query);
  }

  /**
   * Registro de TODAS las peticiones HTTP (también las rechazadas y las de quien no inició sesión): hora, IP, país,
   * navegador, usuario, ruta, código y duración. Filtros: `userId`, `ip`, `country`, `status`, `path`, `from`, `to`.
   */
  @Get('requests')
  @Roles('ADMIN')
  requests(@Query() query: RequestLogQueryDto) {
    return this.listRequests.execute(query);
  }
}
