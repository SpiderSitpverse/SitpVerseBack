import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessRequestsController } from './adapters/http/access-requests.controller';
import { AuditController } from './adapters/http/audit.controller';
import { AuthController } from './adapters/http/auth.controller';
import { UsersController } from './adapters/http/users.controller';
import { AuthGuard } from './adapters/http/auth.guard';
import {
  ApproveAccessRequestUseCase,
  ListAccessRequestsUseCase,
  RejectAccessRequestUseCase,
} from './application/access-requests.use-cases';
import { AuthenticateTokenUseCase } from './application/authenticate-token.use-case';
import { GoogleLoginUseCase } from './application/google-login.use-case';
import { ListAuditUseCase, ListRequestLogUseCase } from './application/list-audit.use-case';
import {
  CreateUserUseCase,
  FindActiveUserUseCase,
  ListUsersUseCase,
  UpdateUserUseCase,
} from './application/manage-users.use-cases';
import { ACCESS_REQUEST_REPOSITORY } from './domain/ports/access-request-repository.port';
import { AUDIT_LOG } from './domain/ports/audit-log.port';
import { REQUEST_SINK } from '../../shared/domain/request-sink.port';
import { REQUEST_LOG } from './domain/ports/request-log.port';
import { AUTH_NONCE_STORE } from './domain/ports/auth-nonce.port';
import { ID_TOKEN_VERIFIER } from './domain/ports/id-token-verifier.port';
import { LOGIN_RATE_LIMITER } from './domain/ports/login-rate-limiter.port';
import { TOKEN_SERVICE } from './domain/ports/token-service.port';
import { USER_ADMIN_REPOSITORY } from './domain/ports/user-admin-repository.port';
import { USER_DIRECTORY } from './domain/ports/user-directory.port';
import { PrismaAccessRequestRepository } from './infrastructure/prisma/prisma-access-request-repository';
import { LogRetentionService } from './infrastructure/prisma/log-retention.service';
import { PrismaAuditLog } from './infrastructure/prisma/prisma-audit-log';
import { PrismaRequestLog } from './infrastructure/prisma/prisma-request-log';
import { PrismaUserDirectory } from './infrastructure/prisma/prisma-user-directory';
import { GoogleIdTokenVerifier } from './infrastructure/security/google-id-token-verifier';
import { JwtTokenService } from './infrastructure/security/jwt-token-service';
import { RedisAuthNonceStore } from './infrastructure/security/redis-auth-nonce-store';
import { RedisLoginRateLimiter } from './infrastructure/security/redis-login-rate-limiter';

/**
 * Identidad y control de acceso. Dueño de las tablas `users` y `audit_log`.
 * La identidad la verifica Google (OpenID Connect); la autorización (el rol) la decide SitpVerse.
 * Registra el AuthGuard como guard GLOBAL: ninguna ruta de ningún módulo queda sin proteger.
 */
@Module({
  controllers: [AuthController, UsersController, AccessRequestsController, AuditController],
  providers: [
    GoogleLoginUseCase,
    AuthenticateTokenUseCase,
    ListUsersUseCase,
    CreateUserUseCase,
    UpdateUserUseCase,
    FindActiveUserUseCase,
    ListAuditUseCase,
    ListRequestLogUseCase,
    PrismaRequestLog,
    LogRetentionService,
    { provide: REQUEST_LOG, useExisting: PrismaRequestLog },
    { provide: REQUEST_SINK, useExisting: PrismaRequestLog },
    ListAccessRequestsUseCase,
    ApproveAccessRequestUseCase,
    RejectAccessRequestUseCase,
    PrismaAccessRequestRepository,
    { provide: ACCESS_REQUEST_REPOSITORY, useExisting: PrismaAccessRequestRepository },
    PrismaUserDirectory,
    PrismaAuditLog,
    { provide: USER_DIRECTORY, useExisting: PrismaUserDirectory },
    { provide: USER_ADMIN_REPOSITORY, useExisting: PrismaUserDirectory },
    { provide: AUDIT_LOG, useExisting: PrismaAuditLog },
    { provide: ID_TOKEN_VERIFIER, useClass: GoogleIdTokenVerifier },
    { provide: AUTH_NONCE_STORE, useClass: RedisAuthNonceStore },
    { provide: LOGIN_RATE_LIMITER, useClass: RedisLoginRateLimiter },
    { provide: TOKEN_SERVICE, useClass: JwtTokenService },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthenticateTokenUseCase, FindActiveUserUseCase, AUDIT_LOG, REQUEST_SINK],
})
export class IdentityModule {}
