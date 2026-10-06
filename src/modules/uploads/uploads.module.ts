import { Module } from '@nestjs/common';
import { UploadsController } from './adapters/http/uploads.controller';

/** Subida de archivos (hoy solo fotos). Usa el FILE_STORAGE global: disco local o, mañana, Blob Storage. */
@Module({ controllers: [UploadsController] })
export class UploadsModule {}
