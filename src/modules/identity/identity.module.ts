import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './adapters/http/auth.controller';
import { UsersController } from './adapters/http/users.controller';
import { AuthGuard } from './adapters/http/auth.guard';
import { AuthenticateTokenUseCase } from './application/authenticate-token.use-case';
import { LoginUseCase } from './application/login.use-case';
import {
  ChangeOwnPasswordUseCase,
  CreateUserUseCase,
  FindActiveUserUseCase,
  ListUsersUseCase,
  ResetPasswordUseCase,
  UpdateUserUseCase,
} from './application/manage-users.use-cases';
import { PASSWORD_HASHER } from './domain/ports/password-hasher.port';
import { TOKEN_SERVICE } from './domain/ports/token-service.port';
import { USER_ADMIN_REPOSITORY } from './domain/ports/user-admin-repository.port';
import { USER_DIRECTORY } from './domain/ports/user-directory.port';
import { PrismaUserDirectory } from './infrastructure/prisma/prisma-user-directory';
import { BcryptPasswordHasher } from './infrastructure/security/bcrypt-password-hasher';
import { JwtTokenService } from './infrastructure/security/jwt-token-service';

/**
 * Identidad y control de acceso. Dueño de la tabla `users`.
 * Registra el AuthGuard como guard GLOBAL: ninguna ruta de ningún módulo queda sin proteger.
 */
@Module({
  controllers: [AuthController, UsersController],
  providers: [
    LoginUseCase,
    AuthenticateTokenUseCase,
    ListUsersUseCase,
    CreateUserUseCase,
    UpdateUserUseCase,
    ResetPasswordUseCase,
    ChangeOwnPasswordUseCase,
    FindActiveUserUseCase,
    PrismaUserDirectory,
    { provide: USER_DIRECTORY, useExisting: PrismaUserDirectory },
    { provide: USER_ADMIN_REPOSITORY, useExisting: PrismaUserDirectory },
    { provide: PASSWORD_HASHER, useClass: BcryptPasswordHasher },
    { provide: TOKEN_SERVICE, useClass: JwtTokenService },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthenticateTokenUseCase, FindActiveUserUseCase],
})
export class IdentityModule {}
