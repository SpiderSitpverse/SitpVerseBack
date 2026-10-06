export const FILE_STORAGE = Symbol('FILE_STORAGE');

export type ImageType = 'jpeg' | 'png' | 'webp';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Detecta el tipo REAL de una imagen por sus primeros bytes (firma del archivo), no por el
 * nombre ni el `Content-Type` que declara el cliente (ambos se pueden falsear).
 * Devuelve null si no es JPEG, PNG ni WebP.
 */
export function detectImageType(buffer: Buffer): ImageType | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/** Una URL de foto válida es SOLO una de las que generó `saveImage` (nada de enlaces externos ni scripts). */
const UPLOADED_IMAGE_URL = /^\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

export function isUploadedImageUrl(url: unknown): url is string {
  return typeof url === 'string' && UPLOADED_IMAGE_URL.test(url);
}

/**
 * Puerto: dónde se guardan los archivos subidos.
 * Hoy el disco local (`LocalFileStorage`); en la nube se cambia por Azure Blob Storage
 * reescribiendo solo el adapter.
 */
export interface FileStoragePort {
  /** Guarda la imagen y devuelve la URL pública relativa (p. ej. `/uploads/<id>.jpg`). */
  saveImage(buffer: Buffer, type: ImageType): Promise<{ url: string }>;
  /** Borra un archivo guardado (se usa para no dejar huérfanos si el registro falla). */
  remove(url: string): Promise<void>;
}
