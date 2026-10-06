import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { basename, join, resolve } from 'path';
import { FileStoragePort, ImageType } from '../../domain/file-storage.port';

export const UPLOADS_URL_PREFIX = '/uploads';

const EXTENSION: Record<ImageType, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };

/**
 * Guarda las imágenes en una carpeta del disco (`UPLOADS_DIR`, por defecto `./uploads`).
 *
 * El nombre es un UUID aleatorio generado aquí (nunca el que manda el cliente): evita
 * sobrescribir archivos y que alguien adivine o recorra rutas (path traversal).
 *
 * Límite conocido: en App Service el disco solo persiste dentro de `/home`; para producción
 * seria conviene Azure Blob Storage (reemplazando solo este adapter).
 */
@Injectable()
export class LocalFileStorage implements FileStoragePort {
  readonly directory: string;

  constructor(config: ConfigService) {
    this.directory = resolve(config.get<string>('UPLOADS_DIR', 'uploads'));
  }

  async saveImage(buffer: Buffer, type: ImageType): Promise<{ url: string }> {
    await mkdir(this.directory, { recursive: true });
    const name = `${randomUUID()}.${EXTENSION[type]}`;
    await writeFile(join(this.directory, name), buffer, { flag: 'wx' });
    return { url: `${UPLOADS_URL_PREFIX}/${name}` };
  }

  async remove(url: string): Promise<void> {
    // basename: aunque llegara una URL manipulada, solo se borra dentro de la carpeta de subidas.
    await unlink(join(this.directory, basename(url))).catch(() => undefined);
  }
}
