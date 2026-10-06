import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { ChangeOwnPasswordUseCase } from '../../application/manage-users.use-cases';
import { LoginUseCase } from '../../application/login.use-case';
import { AuthenticatedUser } from '../../domain/models/authenticated-user';
import { CurrentUser, Public, Roles } from './auth.decorators';

export class LoginDto {
  @IsString() @MinLength(1) @MaxLength(32) employeeId: string;
  @IsString() @MinLength(1) @MaxLength(128) password: string;
}

export class ChangePasswordDto {
  @IsString() @MaxLength(128) currentPassword: string;
  @IsString() @MaxLength(128) newPassword: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly login: LoginUseCase,
    private readonly changePassword: ChangeOwnPasswordUseCase,
  ) {}

  /**
   * HU-02: inicia sesión. Devuelve `{ accessToken, expiresIn, user }`.
   * El front guarda el token y lo envía en `Authorization: Bearer <token>` (HTTP)
   * y en `auth: { token }` al abrir el WebSocket.
   */
  @Post('login')
  @Public()
  @HttpCode(200)
  signIn(@Body() body: LoginDto) {
    return this.login.execute(body.employeeId, body.password);
  }

  /** Quién soy según mi token (sirve para restaurar la sesión al recargar el front). */
  @Get('me')
  @Roles('ADMIN', 'DRIVER', 'MECHANICAL')
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }

  /** Cambia MI contraseña (pantalla "Configuración"). 401 si la actual es incorrecta; 400 si la nueva es débil. */
  @Post('change-password')
  @Roles('ADMIN', 'DRIVER', 'MECHANICAL')
  @HttpCode(204)
  async changeOwnPassword(@CurrentUser() user: AuthenticatedUser, @Body() body: ChangePasswordDto) {
    await this.changePassword.execute(user.id, body.currentPassword, body.newPassword);
  }
}
