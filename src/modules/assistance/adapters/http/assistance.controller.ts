import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FILE_STORAGE, FileStoragePort } from '../../../../shared/domain/file-storage.port';
import { InvalidInputError } from '../../../../shared/domain/errors';
import { SinglePhotoInterceptor, storeUploadedImage } from '../../../../shared/http/image-upload';
import { AuthenticatedUser, CurrentUser, Roles } from '../../../identity/public';
import { AcceptCallUseCase } from '../../application/use-cases/accept-call.use-case';
import { CancelClaimUseCase } from '../../application/use-cases/cancel-claim.use-case';
import { CompleteCallUseCase } from '../../application/use-cases/complete-call.use-case';
import { DeleteIncidentUseCase } from '../../application/use-cases/delete-incident.use-case';
import { GetMyProfileUseCase } from '../../application/use-cases/get-my-profile.use-case';
import { ListCallsUseCase } from '../../application/use-cases/list-calls.use-case';
import { ListIncidentsUseCase } from '../../application/use-cases/list-incidents.use-case';
import { ReportBusFaultUseCase } from '../../application/use-cases/report-bus-fault.use-case';
import { ReportDriverIncidentUseCase } from '../../application/use-cases/report-driver-incident.use-case';
import { RequestDriverSupportUseCase } from '../../application/use-cases/request-driver-support.use-case';
import { ResendCallUseCase } from '../../application/use-cases/resend-call.use-case';
import { RoutingService } from '../../infrastructure/prisma/routing.service';
import { AssignAlternativeRouteRequestDto, AssignTowRequestDto, AttachIncidentEvidenceDto, CreateAlternativeRouteDto, CreateBlockageDto, ListTowReportsDto } from '../../application/dtos/routing.dto';
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
    private readonly deleteIncident: DeleteIncidentUseCase,
    private readonly listCalls: ListCallsUseCase,
    private readonly myProfile: GetMyProfileUseCase,
    private readonly routing: RoutingService,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
  ) {}

  /** HU-16/HU-45 — bloqueos e incidentes visibles para operación. */
  @Get('blockages')
  @Roles('ADMIN', 'DRIVER', 'MECHANICAL')
  blockages() {
    return this.routing.listBlockages();
  }

  /** HU-16 — un conductor puede reportar un bloqueo y administración lo recibe en tiempo real. */
  @Post('blockages')
  @Roles('DRIVER', 'ADMIN')
  reportBlockage(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateBlockageDto) {
    return this.routing.reportBlockage({ ...body, reportedById: user.id, reportedByName: user.name });
  }

  /** HU-44 — administración reenvía el bloqueo a todos los conductores de la flota. */
  @Post('blockages/:id/alert')
  @Roles('ADMIN')
  alertFleet(@Param('id', ParseUUIDPipe) incidentId: string) {
    return this.routing.alertFleet(incidentId);
  }

  /** HU-30 — asignar grúa y cuadrilla al incidente. */
  @Post('blockages/:id/tow')
  @Roles('ADMIN')
  assignTow(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) incidentId: string,
    @Body() body: AssignTowRequestDto,
  ) {
    return this.routing.assignTow(user.id, { ...body, incidentId });
  }

  /** HU-22 — adjuntar evidencia fotográfica al incidente. */
  @Post('incidents/:id/evidence')
  @Roles('DRIVER', 'ADMIN', 'MECHANICAL')
  attachEvidence(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) incidentId: string,
    @Body() body: AttachIncidentEvidenceDto,
  ) {
    return this.routing.attachEvidence(user.id, incidentId, body);
  }

  /**
   * HU-22 — sube una FOTO como evidencia (multipart/form-data).
   * Campos: `photo` (archivo JPEG/PNG/WebP, máx. 5 MB), `caption` y `capturedAt` (opcionales).
   * Devuelve el registro de evidencia con su `url` relativa (p. ej. `/uploads/<id>.jpg`).
   */
  @Post('incidents/:id/evidence/upload')
  @Roles('DRIVER', 'ADMIN', 'MECHANICAL')
  @UseInterceptors(SinglePhotoInterceptor())
  async uploadEvidence(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) incidentId: string,
    @UploadedFile() photo: Express.Multer.File | undefined,
    @Body() body: { caption?: string; capturedAt?: string },
  ) {
    if (body.capturedAt && Number.isNaN(Date.parse(body.capturedAt))) {
      throw new InvalidInputError('capturedAt debe ser una fecha ISO válida');
    }
    const { url } = await storeUploadedImage(this.storage, photo);
    try {
      return await this.routing.attachEvidence(user.id, incidentId, {
        url,
        caption: body.caption?.slice(0, 500),
        capturedAt: body.capturedAt,
      });
    } catch (error) {
      await this.storage.remove(url); // no dejar el archivo huérfano si el incidente no existe
      throw error;
    }
  }

  @Get('incidents/:id/evidence')
  @Roles('ADMIN', 'DRIVER', 'MECHANICAL')
  evidence(@Param('id', ParseUUIDPipe) incidentId: string) {
    return this.routing.listEvidence(incidentId);
  }

  /** HU-50 — reportes consultables de grúas y cuadrillas. */
  @Get('tow-reports')
  @Roles('ADMIN')
  towReports(@Query() query: ListTowReportsDto) {
    return this.routing.listTowReports(query);
  }

  /** HU-46/HU-45 — rutas alternativas propuestas para un incidente. */
  @Get('incidents/:id/routes')
  @Roles('ADMIN', 'DRIVER', 'MECHANICAL')
  routes(@Param('id', ParseUUIDPipe) incidentId: string) {
    return this.routing.listRoutes(incidentId);
  }

  /** HU-47 — proponer una ruta alternativa desde el mapa. */
  @Post('incidents/:id/routes')
  @Roles('ADMIN')
  proposeRoute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) incidentId: string,
    @Body() body: CreateAlternativeRouteDto,
  ) {
    return this.routing.createRoute(user.id, incidentId, body);
  }

  /** HU-47/HU-48 — asignar una ruta a un conductor desde el mapa. */
  @Post('routes/:routeId/assign')
  @Roles('ADMIN')
  assignRoute(
    @Param('routeId', ParseUUIDPipe) routeId: string,
    @Body() body: AssignAlternativeRouteRequestDto,
  ) {
    return this.routing.assignRoute(routeId, body.driverId);
  }

  /** HU-48 — consultar el servicio/ruta asignado al conductor. */
  @Get('routes/assigned/me')
  @Roles('DRIVER')
  assignedRoutes(@CurrentUser() user: AuthenticatedUser) {
    return this.routing.assignedRoutes(user.id);
  }

  /** HU-17/HU-52 — aceptar la ruta alternativa asignada. */
  @Post('routes/:routeId/accept')
  @Roles('DRIVER')
  acceptRoute(@CurrentUser() user: AuthenticatedUser, @Param('routeId', ParseUUIDPipe) routeId: string) {
    return this.routing.acceptRoute(routeId, user.id);
  }

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

  /** El admin elimina un incidente que nadie atendió (409 si ya tiene aceptaciones o está terminado). */
  @Delete('incidents/:id')
  @Roles('ADMIN')
  removeIncident(@Param('id', ParseUUIDPipe) id: string) {
    return this.deleteIncident.execute(id);
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
