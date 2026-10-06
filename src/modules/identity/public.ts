/**
 * API PÚBLICA del módulo identity: lo único que otros módulos pueden importar de aquí.
 * (Un test de arquitectura lo hace cumplir: importar cualquier otro archivo de identity
 * desde fuera del módulo rompe el build.)
 */
export { IdentityModule } from './identity.module';
export { AuthenticateTokenUseCase } from './application/authenticate-token.use-case';
export { FindActiveUserUseCase } from './application/manage-users.use-cases';
export { CurrentUser, Public, Roles } from './adapters/http/auth.decorators';
export type { AuthenticatedUser } from './domain/models/authenticated-user';
