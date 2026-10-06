import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { USER_ROLES, UserRole } from '../../../../shared/domain/roles';
import {
  CreateUserUseCase,
  ListUsersUseCase,
  ResetPasswordUseCase,
  UpdateUserUseCase,
} from '../../application/manage-users.use-cases';
import { AuthenticatedUser } from '../../domain/models/authenticated-user';
import { CurrentUser, Roles } from './auth.decorators';

export class CreateUserDto {
  @IsString() @MinLength(3) @MaxLength(32) employeeId: string;
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsEnum(USER_ROLES) role: UserRole;
  @IsString() @MaxLength(128) password: string;
}

export class UpdateUserDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsEnum(USER_ROLES) role?: UserRole;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class ResetPasswordDto {
  @IsString() @MaxLength(128) newPassword: string;
}

/** Administración de personal (pantalla "Usuarios"). Solo para administradores. */
@Controller('users')
export class UsersController {
  constructor(
    private readonly listUsers: ListUsersUseCase,
    private readonly createUser: CreateUserUseCase,
    private readonly updateUser: UpdateUserUseCase,
    private readonly resetPassword: ResetPasswordUseCase,
  ) {}

  /** Personal registrado, con rol y si la cuenta está activa. */
  @Get()
  @Roles('ADMIN')
  list() {
    return this.listUsers.execute();
  }

  /** HU-04: crea una cuenta. 409 si el número de empleado ya existe. */
  @Post()
  @Roles('ADMIN')
  create(@Body() body: CreateUserDto) {
    return this.createUser.execute(body);
  }

  /** HU-05 / HU-06: cambia nombre o rol, o desactiva/reactiva la cuenta (`active`). */
  @Patch(':id')
  @Roles('ADMIN')
  update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateUserDto,
  ) {
    return this.updateUser.execute(admin.id, id, body);
  }

  /** El admin asigna una contraseña nueva a un empleado. */
  @Post(':id/reset-password')
  @Roles('ADMIN')
  @HttpCode(204)
  async reset(@Param('id', ParseUUIDPipe) id: string, @Body() body: ResetPasswordDto) {
    await this.resetPassword.execute(id, body.newPassword);
  }
}
