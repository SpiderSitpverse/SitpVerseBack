import { FileInterceptor } from '@nestjs/platform-express';
import { InvalidInputError } from '../domain/errors';
import {
  FileStoragePort,
  MAX_IMAGE_BYTES,
  detectImageType,
} from '../domain/file-storage.port';

/** Interceptor de multer para UNA foto en el campo `photo` (máx. 5 MB; lo mayor responde 413). */
export const SinglePhotoInterceptor = () =>
  FileInterceptor('photo', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });

/**
 * Valida y guarda la foto subida. Se comprueba el CONTENIDO real del archivo (su firma), no el
 * nombre ni el `Content-Type` que declara el cliente, que se pueden falsear.
 */
export async function storeUploadedImage(
  storage: FileStoragePort,
  file: Express.Multer.File | undefined,
): Promise<{ url: string }> {
  if (!file) throw new InvalidInputError('Falta el archivo en el campo "photo"');
  const type = detectImageType(file.buffer);
  if (!type) throw new InvalidInputError('El archivo debe ser una imagen JPEG, PNG o WebP');
  return storage.saveImage(file.buffer, type);
}
