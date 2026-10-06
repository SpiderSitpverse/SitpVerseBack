import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import {
  AudienceEvent,
  REDIS_STREAMS,
} from '../../shared/contracts/realtime.contract';
import { REDIS_STREAM_CLIENT } from '../../shared/infrastructure/redis.provider';
import { RealtimeGateway } from '../websocket/realtime.gateway';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lee el stream de alertas (alimentado por el outbox) y entrega cada evento a los sockets
 * de su audiencia.
 *
 * Por qué Streams y no Pub/Sub: Pub/Sub es "disparar y olvidar": si este proceso estaba
 * reconectándose en ese instante, el mensaje se pierde. Aquí el consumidor recuerda el
 * último id leído y, tras cualquier corte, CONTINÚA desde ahí. TODAS las instancias del
 * backend leen el stream completo (no es un consumer group: cada una atiende a SUS sockets).
 *
 * Entrega at-least-once: los eventos llevan `eventId` y el cliente descarta duplicados.
 * Un cliente que estuvo desconectado se pone al día con la reproducción del gateway.
 */
@Injectable()
export class RedisStreamConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisStreamConsumer.name);
  private running = false;

  constructor(
    @Inject(REDIS_STREAM_CLIENT) private readonly redis: Redis,
    private readonly gateway: RealtimeGateway,
  ) {}

  onModuleInit() {
    this.running = true;
    void this.loop();
  }

  onModuleDestroy() {
    this.running = false;
    this.redis.disconnect(); // interrumpe el XREAD bloqueado
  }

  private async loop() {
    let lastId: string | undefined;
    while (this.running) {
      try {
        // Punto de partida: "ahora" según el reloj de Redis (lo anterior lo cubre la reproducción).
        lastId ??= await this.currentStreamTime();

        const result = await this.redis.xread(
          'COUNT', 100, 'BLOCK', 5000, 'STREAMS', REDIS_STREAMS.ASSISTANCE, lastId,
        );
        for (const [, entries] of result ?? []) {
          for (const [id, fields] of entries) {
            lastId = id;
            this.deliver(fields);
          }
        }
      } catch (err) {
        if (!this.running) return;
        this.logger.error(`Lectura del stream falló, reintento en 1s: ${err}`);
        await sleep(1000);
      }
    }
  }

  private deliver(fields: string[]) {
    try {
      const event = JSON.parse(fields[fields.indexOf('data') + 1]) as AudienceEvent;
      this.gateway.broadcastToAudience(event);
    } catch (err) {
      this.logger.error(`Evento inválido en el stream: ${err}`);
    }
  }

  private async currentStreamTime(): Promise<string> {
    const [seconds, micros] = await this.redis.time();
    return `${Number(seconds) * 1000 + Math.floor(Number(micros) / 1000)}-0`;
  }
}
