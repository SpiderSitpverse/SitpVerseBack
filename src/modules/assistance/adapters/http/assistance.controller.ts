import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { AuthenticatedUser, CurrentUser, Roles } from '../../../identity/public';
import { AcceptCallUseCase } from '../../application/use-cases/accept-call.use-case';
import { CancelClaimUseCase } from '../../application/use-cases/cancel-claim.use-case';
import { CompleteCallUseCase } from '../../application/use-cases/complete-call.use-case';
import { GetMyProfileUseCase } from '../../application/use-cases/get-my-profile.use-case';
import { ListCallsUseCase } from '../../application/use-cases/list-calls.use-case';
import { ListIncidentsUseCase } from '../../application/use-cases/list-incidents.use-case';
import { ReportBusFaultUseCase } from '../../application/use-cases/report-bus-fault.use-case';
import { ReportDriverIncidentUseCase } from '../../application/use-cases/report-driver-incident.use-case';
import { RequestDriverSupportUseCase } from '../../application/use-cases/request-driver-support.use-case';
import { ResendCallUseCase } from '../../application/use-cases/resend-call.use-case';
import {
  BusFaultDto,
  ListCallsDto,
  ReportIncidentDto,
  SupportCallDto,
} from '../../application/dtos/assistance.dto';

/**
 * Adapter HTTP de asistencia. El acceso lo valida el guard GLOBAL de `identity`: cada ruta
 * DEBE declarar `@Roles(...)` (si no, se rechaza).
 */
@Controller('assistance')
export class AssistanceController {
  constructor(
    private readonly reportIncident: ReportDriverIncidentUseCase,
    private readonly requestSupport: RequestDriverSupportUseCase,
    private readonly reportFault: ReportBusFaultUseCase,
    private readonly acceptCall: AcceptCallUseCase,
    private readonly cancelClaim: CancelClaimUseCase,
    private readonly resendCall: ResendCallUseCase,
    private readonly completeCall: CompleteCallUseCase,
    private readonly listIncidents: ListIncidentsUseCase,
    private readonly listCalls: ListCallsUseCase,
    private readonly myProfile: GetMyProfileUseCase,
  ) {}

  /** Uso 1 · paso 1: el conductor avisa a administración. */
  @Post('incidents')
  @Roles('DRIVER')
  report(@CurrentUser() user: AuthenticatedUser, @Body() body: ReportIncidentDto) {
    return this.reportIncident.execute(user, body);
  }

  @Get('incidents')
  @Roles('ADMIN')
  incidents() {
    return this.listIncidents.execute();
  }

  /** Uso 1 · paso 2: el admin lanza la alerta a conductores (N cupos + recompensa). */
  @Post('incidents/:id/support-call')
  @Roles('ADMIN')
  support(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SupportCallDto,
  ) {
    return this.requestSupport.execute(user, id, body);
  }

  /** Uso 2: fallo de un bus → alerta a mecánicos (1 cupo). */
  @Post('bus-faults')
  @Roles('DRIVER', 'ADMIN')
  fault(@CurrentUser() user: AuthenticatedUser, @Body() body: BusFaultDto) {
    return this.reportFault.execute(user, body);
  }

  /** Alertas visibles para el rol, con aceptaciones y plazo `arriveBy` (también sirve para reconciliar). */
  @Get('calls')
  @Roles('ADMIN', 'DRIVER', 'MECHANICAL')
  calls(@CurrentUser() user: AuthenticatedUser, @Query() query: ListCallsDto) {
    return this.listCalls.execute(user, query.status);
  }

  /** Los primeros en llegar toman el cupo (409 si ya se llenó). */
  @Post('calls/:id/accept')
  @Roles('DRIVER', 'MECHANICAL')
  accept(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.acceptCall.execute(user, id);
  }

  /** El admin cancela una aceptación que no llegó a tiempo (libera el cupo). */
  @Post('calls/:id/claims/:claimId/cancel')
  @Roles('ADMIN')
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('claimId', ParseUUIDPipe) claimId: string,
  ) {
    return this.cancelClaim.execute(user, id, claimId);
  }

  /** El admin reenvía la alerta con los cupos libres. */
  @Post('calls/:id/resend')
  @Roles('ADMIN')
  resend(@Param('id', ParseUUIDPipe) id: string) {
    return this.resendCall.execute(id);
  }

  /** Cierra el servicio y acredita los puntos. */
  @Post('calls/:id/complete')
  @Roles('ADMIN', 'MECHANICAL')
  complete(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.completeCall.execute(user, id);
  }

  @Get('me')
  @Roles('ADMIN', 'DRIVER', 'MECHANICAL')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.myProfile.execute(user);
  }
}
