import { Body, Controller, Get, HttpCode, Ip, Post } from '@nestjs/common';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { GoogleLoginUseCase } from '../../application/google-login.use-case';
import { AuthenticatedUser } from '../../domain/models/authenticated-user';
import { CurrentUser, Public, Roles } from './auth.decorators';

export class GoogleLoginDto {
  /** ID token (JWT firmado por Google) que entrega el inicio de sesión de Google en el front. */
  @IsString() @MinLength(20) @MaxLength(8192) idToken: string;
  /** El nonce que se obtuvo de `GET /auth/nonce` y se puso en la petición a Google. */
  @IsString() @Matches(/^[A-Za-z0-9_-]{16,128}$/) nonce: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly googleLogin: GoogleLoginUseCase) {}

  /**
   * Paso previo al inicio de sesión: entrega un `nonce` de un solo uso (5 min) que el front pone en la petición a
   * Google. El ID token lo trae de vuelta y `POST /auth/google` lo exige: una respuesta ya usada no sirve otra vez.
   */
  @Get('nonce')
  @Public()
  async nonce(@Ip() ip: string) {
    return { nonce: await this.googleLogin.issueNonce(ip) };
  }

  /**
   * HU-02: inicia sesión con Google (OpenID Connect). Devuelve `{ accessToken, expiresIn, user }`.
   * El front guarda el token y lo envía en `Authorization: Bearer <token>` (HTTP)
   * y en `auth: { token }` al abrir el WebSocket.
   *
   * 401: ID token inválido, vencido, de otra aplicación o con correo sin verificar.
   * 403: la cuenta de Google no está prerregistrada o está desactivada (mismo mensaje en ambos casos).
   * 429: más de 10 intentos por minuto desde una IP (con `Retry-After`).
   */
  @Post('google')
  @Public()
  @HttpCode(200)
  signIn(@Body() body: GoogleLoginDto, @Ip() ip: string) {
    return this.googleLogin.execute(body.idToken, body.nonce, ip);
  }

  /** Quién soy según mi token (sirve para restaurar la sesión al recargar el front). */
  @Get('me')
  @Roles('ADMIN', 'DRIVER', 'MECHANICAL')
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }
}
