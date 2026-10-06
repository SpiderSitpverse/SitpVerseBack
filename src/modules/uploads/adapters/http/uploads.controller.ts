import { Controller, Inject, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FILE_STORAGE, FileStoragePort } from '../../../../shared/domain/file-storage.port';
import { SinglePhotoInterceptor, storeUploadedImage } from '../../../../shared/http/image-upload';
import { Roles } from '../../../identity/public';

/**
 * Subida general de fotos. El front sube cada foto aquí PRIMERO y luego envía las URLs devueltas
 * dentro de la inspección, el informe de reparación, etc.:
 *
 *   POST /files/images   (multipart/form-data, campo `photo`, JPEG/PNG/WebP hasta 5 MB)
 *   → 201 { "url": "/uploads/<id>.jpg" }       (se muestra con <img src={API + url}>)
 */
@Controller('files')
export class UploadsController {
  constructor(@Inject(FILE_STORAGE) private readonly storage: FileStoragePort) {}

  @Post('images')
  @Roles('ADMIN', 'DRIVER', 'MECHANICAL')
  @UseInterceptors(SinglePhotoInterceptor())
  uploadImage(@UploadedFile() photo: Express.Multer.File | undefined) {
    return storeUploadedImage(this.storage, photo);
  }
}
