import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { AuthenticatedUser, CurrentUser, Roles } from '../../../identity/public';
import {
  GetAssistanceSummaryUseCase,
  GetRepairReportUseCase,
  ListRepairReportsUseCase,
  SaveRepairReportUseCase,
} from '../../application/use-cases/repair-reports.use-cases';

class ExpenseDto {
  @IsString() @MaxLength(120) concepto: string;
  @IsNumber() valor: number;
}

export class SaveRepairReportDto {
  @IsOptional() @IsString() @MaxLength(4000) damages?: string;
  @IsOptional() @IsString() @MaxLength(4000) replacedParts?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => ExpenseDto)
  expenses?: ExpenseDto[];
  /** URLs devueltas por `POST /files/images`. */
  @IsOptional() @IsArray() @ArrayMaxSize(10) busPhotos?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(10) partPhotos?: string[];
  /** `true` = "Finalizar servicio": deja el informe definitivo y cierra la alerta. */
  @IsOptional() @IsBoolean() finalize?: boolean;
}

/** Informes de reparación del mecánico y resumen del panel (rutas de `/assistance`). */
@Controller('assistance')
export class RepairReportsController {
  constructor(
    private readonly saveReport: SaveRepairReportUseCase,
    private readonly getReport: GetRepairReportUseCase,
    private readonly listReports: ListRepairReportsUseCase,
    private readonly summary: GetAssistanceSummaryUseCase,
  ) {}

  /**
   * Guarda el informe como borrador, o lo finaliza con `"finalize": true` (cierra la reparación y
   * acredita el bono). Solo el mecánico que aceptó esa reparación. 409 si el informe ya es definitivo.
   */
  @Put('calls/:id/repair-report')
  @Roles('MECHANICAL')
  save(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) callId: string,
    @Body() body: SaveRepairReportDto,
  ) {
    return this.saveReport.execute(user, callId, body, body.finalize === true);
  }

  @Get('calls/:id/repair-report')
  @Roles('ADMIN', 'MECHANICAL')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) callId: string) {
    return this.getReport.execute(user, callId);
  }

  /** Historial: el admin ve todos; el mecánico, los suyos. Incluye los datos del bus. */
  @Get('repair-reports')
  @Roles('ADMIN', 'MECHANICAL')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.listReports.execute(user);
  }

  /** Números del panel: incidentes de las últimas 24 h, alertas abiertas, reparaciones en curso... */
  @Get('summary')
  @Roles('ADMIN')
  getSummary() {
    return this.summary.execute();
  }
}
