import { Injectable } from '@nestjs/common';
import { FindActiveUserUseCase } from '../../../identity/public';
import { DriverDirectoryPort, DriverRef } from '../../domain/ports/driver-directory.port';

/** Adapter hacia `identity`: usa solo su API pública, nunca su tabla. */
@Injectable()
export class IdentityDriverDirectory implements DriverDirectoryPort {
  constructor(private readonly users: FindActiveUserUseCase) {}

  async findActiveDriver(userId: string): Promise<DriverRef | null> {
    const user = await this.users.execute(userId);
    return user?.role === 'DRIVER' ? { id: user.id, name: user.name } : null;
  }
}
