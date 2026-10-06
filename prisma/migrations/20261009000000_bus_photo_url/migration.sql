-- Foto real del bus: URL de una imagen ya subida (POST /files/images). La sube o cambia el administrador.
ALTER TABLE "buses" ADD COLUMN "photoUrl" TEXT;
