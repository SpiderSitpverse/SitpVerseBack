import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { RealtimeIoAdapter } from './realtime/websocket/realtime-io.adapter';
import { AppErrorFilter } from './shared/http/app-error.filter';
import {
  LocalFileStorage,
  UPLOADS_URL_PREFIX,
} from './shared/infrastructure/storage/local-file-storage';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  app.enableCors({ origin: config.get<string>('CORS_ORIGIN', '*').split(',') });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AppErrorFilter()); // errores de dominio → 401 / 403 / 404 / 409 / 503
  app.useWebSocketAdapter(new RealtimeIoAdapter(app));
  app.enableShutdownHooks(); // cierra Prisma y Redis limpiamente con SIGTERM

  // Fotos de evidencia subidas. Los nombres son UUID aleatorios (no se pueden adivinar), así
  // el front puede usarlas directamente en <img src>. Se sirven sin listar el directorio.
  app.useStaticAssets(app.get(LocalFileStorage).directory, {
    prefix: `${UPLOADS_URL_PREFIX}/`,
    index: false,
    dotfiles: 'deny',
  });

  const port = config.get<number>('PORT', 3000);
  await app.listen(port);
  console.log(`🚌 SitpVerse backend corriendo en http://localhost:${port}`);
}
bootstrap();
