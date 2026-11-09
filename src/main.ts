import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { RealtimeIoAdapter } from './realtime/websocket/realtime-io.adapter';
import { AppErrorFilter } from './shared/http/app-error.filter';
import { TelemetryInterceptor } from './shared/infrastructure/telemetry.interceptor';
import { TelemetryService } from './shared/infrastructure/telemetry';
import { NextFunction, Request, Response } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const telemetry = app.get(TelemetryService);

  app.enableCors({ origin: config.get<string>('CORS_ORIGIN', '*').split(',') });
  app.use((request: Request, response: Response, next: NextFunction) => {
    const traceId = TelemetryService.newTraceId(request.header('x-trace-id'));
    response.setHeader('x-trace-id', traceId);
    telemetry.run(traceId, next);
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AppErrorFilter()); // errores de dominio → 404 / 403 / 409 / 503
  app.useGlobalInterceptors(app.get(TelemetryInterceptor));
  app.useWebSocketAdapter(new RealtimeIoAdapter(app));
  app.enableShutdownHooks(); // cierra Prisma y Redis limpiamente con SIGTERM

  const port = config.get<number>('PORT', 3000);
  await app.listen(port);
  console.log(`🚌 SitpVerse backend corriendo en http://localhost:${port}`);
}
bootstrap();
