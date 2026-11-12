import { Body, Controller, Get, Ip, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { USER_ROLES, UserRole } from '../../../../shared/domain/roles';
import { CreateUserUseCase, ListUsersUseCase, UpdateUserUseCase } from '../../application/manage-users.use-cases';
import { AuthenticatedUser } from '../../domain/models/authenticated-user';
import { CurrentUser, Roles } from './auth.decorators';

export class CreateUserDto {
  @IsString() @MinLength(3) @MaxLength(32) employeeId: string;
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsEnum(USER_ROLES) role: UserRole;
  /** Correo de la cuenta de Google con la que la persona va a entrar. */
  @IsEmail() @MaxLength(254) email: string;
}

export class UpdateUserDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsEnum(USER_ROLES) role?: UserRole;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

/** Administración de personal (pantalla "Usuarios"). Solo para administradores. */
@Controller('users')
export class UsersController {
  constructor(
    private readonly listUsers: ListUsersUseCase,
    private readonly createUser: CreateUserUseCase,
    private readonly updateUser: UpdateUserUseCase,
  ) {}

  /** Personal registrado, con rol, correo y si la cuenta está activa. */
  @Get()
  @Roles('ADMIN')
  list() {
    return this.listUsers.execute();
  }

  /** HU-04: prerregistra a una persona (sin contraseña). 409 si el número de empleado o el correo ya existen. */
  @Post()
  @Roles('ADMIN')
  create(@CurrentUser() admin: AuthenticatedUser, @Body() body: CreateUserDto, @Ip() ip: string) {
    return this.createUser.execute(admin, body, ip);
  }

  /** HU-05 / HU-06: cambia nombre, rol o correo, o desactiva/reactiva la cuenta (`active`). */
  @Patch(':id')
  @Roles('ADMIN')
  update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateUserDto,
    @Ip() ip: string,
  ) {
    return this.updateUser.execute(admin, id, body, ip);
  }
}
