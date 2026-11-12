import { Body, Controller, Get, HttpCode, Ip, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { USER_ROLES, UserRole } from '../../../../shared/domain/roles';
import {
  ApproveAccessRequestUseCase,
  ListAccessRequestsUseCase,
  RejectAccessRequestUseCase,
} from '../../application/access-requests.use-cases';
import { AuthenticatedUser } from '../../domain/models/authenticated-user';
import { CurrentUser, Roles } from './auth.decorators';

export class ApproveAccessRequestDto {
  /** Rol que se le da a la persona. */
  @IsEnum(USER_ROLES) role: UserRole;
  /** Opcional: si falta, se asigna el siguiente número libre del rol (2006, 3004…). */
  @IsOptional() @IsString() @MinLength(3) @MaxLength(32) employeeId?: string;
  /** Opcional: corrige el nombre que trajo Google. */
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
}

/**
 * Solicitudes de acceso (pantalla "Usuarios"): quien entra con Google sin tener cuenta queda aquí, sin rol ni sesión,
 * hasta que un administrador lo acepta y le da un rol, o lo rechaza. Solo ADMIN.
 */
@Controller('access-requests')
export class AccessRequestsController {
  constructor(
    private readonly listRequests: ListAccessRequestsUseCase,
    private readonly approveRequest: ApproveAccessRequestUseCase,
    private readonly rejectRequest: RejectAccessRequestUseCase,
  ) {}

  /** Quién espera (`PENDING`) y a quién se rechazó (`REJECTED`), de la más antigua a la más reciente. */
  @Get()
  @Roles('ADMIN')
  list() {
    return this.listRequests.execute();
  }

  /** Acepta la solicitud y crea el usuario con el rol elegido. 404 si otro admin ya la decidió; 409 si el número está en uso. */
  @Post(':id/approve')
  @Roles('ADMIN')
  approve(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ApproveAccessRequestDto,
    @Ip() ip: string,
  ) {
    return this.approveRequest.execute(admin, id, body, ip);
  }

  /** Rechaza la solicitud (la persona verá que fue rechazada al volver a entrar). */
  @Post(':id/reject')
  @Roles('ADMIN')
  @HttpCode(204)
  async reject(@CurrentUser() admin: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Ip() ip: string) {
    await this.rejectRequest.execute(admin, id, ip);
  }
}
