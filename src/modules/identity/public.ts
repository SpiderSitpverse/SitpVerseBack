/**
 * API PÚBLICA del módulo identity: lo único que otros módulos pueden importar de aquí.
 * (Un test de arquitectura lo hace cumplir: importar cualquier otro archivo de identity
 * desde fuera del módulo rompe el build.)
 */
export { IdentityModule } from './identity.module';
export { AuthenticateEmployeeUseCase } from './application/authenticate-employee.use-case';
export { CurrentUser, Public, Roles } from './adapters/http/auth.decorators';
export type { AuthenticatedUser } from './domain/models/authenticated-user';
