import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/public';
import {
  RedisStreamProvider,
  RedisSubscriberProvider,
} from '../shared/infrastructure/redis.provider';
import { RedisStreamConsumer } from './subscriptions/redis-stream-consumer.service';
import { RedisSubscriberService } from './subscriptions/redis-subscriber.service';
import { RealtimeGateway } from './websocket/realtime.gateway';

/**
 * Entrega de eventos en tiempo real por WebSocket.
 * Los módulos de negocio NO lo importan: publican en Redis (Pub/Sub para posiciones,
 * Streams vía outbox para alertas) y este módulo escucha. Totalmente desacoplado.
 */
@Module({
  imports: [IdentityModule], // autentica a los sockets con el mismo caso de uso que el HTTP
  providers: [
    RealtimeGateway,
    RedisSubscriberService,
    RedisStreamConsumer,
    // Conexiones dedicadas: una en modo subscribe y otra para XREAD bloqueante no sirven para otros comandos.
    RedisSubscriberProvider,
    RedisStreamProvider,
  ],
})
export class RealtimeModule {}
