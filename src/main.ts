import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { RealtimeIoAdapter } from './realtime/websocket/realtime-io.adapter';
import { AppErrorFilter } from './shared/http/app-error.filter';
import { productionConfigProblems } from './shared/infrastructure/production-config';
import {
  LocalFileStorage,
  UPLOADS_URL_PREFIX,
} from './shared/infrastructure/storage/local-file-storage';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  // En producción la app NO arranca con una configuración insegura o incompleta.
  const problems = productionConfigProblems((key) => config.get<string>(key));
  if (problems.length > 0) {
    throw new Error(`Configuración de producción inválida:\n - ${problems.join('\n - ')}`);
  }

  // Detrás del proxy de Azure la IP real del cliente viene en X-Forwarded-For. Sin esto todos los
  // usuarios parecerían tener la IP del proxy y el límite de intentos de login los bloquearía a todos juntos.
  app.set('trust proxy', 1);

  // Cabeceras de seguridad. `cross-origin` en recursos: el front vive en OTRO origen y pinta las fotos con <img>.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.enableCors({ origin: config.get<string>('CORS_ORIGIN', '*').split(',').map((o) => o.trim()) });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AppErrorFilter()); // errores de dominio → 400 / 401 / 403 / 404 / 409 / 429 / 503
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
