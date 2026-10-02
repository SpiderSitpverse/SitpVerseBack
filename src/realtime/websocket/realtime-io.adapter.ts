import { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';

/**
 * Adaptador de Socket.io que aplica el CORS leyendo `CORS_ORIGIN` con ConfigService.
 * (Un `process.env` dentro del decorador @WebSocketGateway se evalúa ANTES de cargar
 * el `.env`, por eso el origen configurado nunca se aplicaba.)
 */
export class RealtimeIoAdapter extends IoAdapter {
  private readonly origins: string[];

  constructor(app: INestApplicationContext) {
    super(app);
    this.origins = app
      .get(ConfigService)
      .get<string>('CORS_ORIGIN', '*')
      .split(',')
      .map((origin) => origin.trim());
  }

  createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, { ...options, cors: { origin: this.origins } });
  }
}
