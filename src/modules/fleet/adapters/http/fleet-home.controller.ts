import { Controller, Get } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser, Roles } from '../../../identity/public';
import { GetOperativeHomeUseCase } from '../../application/use-cases/get-operative-home.use-case';

/** HU-11: Home del conductor (su bus). GET /fleet/home/operativo */
@Controller('fleet/home')
export class FleetHomeController {
  constructor(private readonly getOperativeHome: GetOperativeHomeUseCase) {}

  @Get('operativo')
  @Roles('DRIVER')
  operativo(@CurrentUser() user: AuthenticatedUser) {
    return this.getOperativeHome.execute(user.id);
  }
}
