import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/infrastructure/prisma.service';
import { AuthenticatedUser } from '../../domain/models/authenticated-user';
import { UserDirectoryPort } from '../../domain/ports/user-directory.port';

@Injectable()
export class PrismaUserDirectory implements UserDirectoryPort {
  constructor(private readonly prisma: PrismaService) {}

  findByEmployeeId(employeeId: string): Promise<AuthenticatedUser | null> {
    return this.prisma.user.findUnique({
      where: { employeeId },
      select: { id: true, employeeId: true, name: true, role: true },
    });
  }
}
