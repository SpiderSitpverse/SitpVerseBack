import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './adapters/http/auth.guard';
import { AuthenticateEmployeeUseCase } from './application/authenticate-employee.use-case';
import { USER_DIRECTORY } from './domain/ports/user-directory.port';
import { PrismaUserDirectory } from './infrastructure/prisma/prisma-user-directory';

/**
 * Identidad y control de acceso. Dueño de la tabla `users`.
 * Registra el AuthGuard como guard GLOBAL: ninguna ruta de ningún módulo queda sin proteger.
 */
@Module({
  providers: [
    AuthenticateEmployeeUseCase,
    { provide: USER_DIRECTORY, useClass: PrismaUserDirectory },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthenticateEmployeeUseCase],
})
export class IdentityModule {}
