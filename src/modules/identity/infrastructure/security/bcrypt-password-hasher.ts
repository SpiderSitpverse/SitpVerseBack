import { Injectable } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';
import { PasswordHasherPort } from '../../domain/ports/password-hasher.port';

/** Costo de bcrypt: ~100 ms por contraseña en un equipo actual (frena la fuerza bruta sin hacer lento el login). */
const BCRYPT_COST = 10;

/** bcryptjs: implementación en JavaScript puro (sin compilar módulos nativos; despliega igual en Windows y Linux). */
@Injectable()
export class BcryptPasswordHasher implements PasswordHasherPort {
  hash(plain: string): Promise<string> {
    return hash(plain, BCRYPT_COST);
  }

  matches(plain: string, hash: string): Promise<boolean> {
    return compare(plain, hash);
  }
}
