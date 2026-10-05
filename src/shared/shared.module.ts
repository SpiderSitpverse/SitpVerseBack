import { Global, Module } from '@nestjs/common';
import { DISTRIBUTED_LOCK } from './domain/distributed-lock.port';
import { OutboxReader } from './infrastructure/outbox/outbox.reader';
import { OutboxRelay } from './infrastructure/outbox/outbox.relay';
import { PrismaService } from './infrastructure/prisma.service';
import { RedisDistributedLock } from './infrastructure/redis-distributed-lock';
import { RedisPublisherProvider, RedisRelayProvider } from './infrastructure/redis.provider';

/**
 * Infraestructura transversal compartida por todos los módulos:
 *  - UNA instancia de Prisma (un pool) y UNA conexión Redis de publicación.
 *  - El lock distribuido FIFO.
 *  - El outbox transaccional: relay (Postgres → Redis Streams) y lector (reproducción).
 */
@Global()
@Module({
  providers: [
    PrismaService,
    RedisPublisherProvider,
    RedisRelayProvider, // conexión propia del relay (falla rápido, ver redis.provider)
    { provide: DISTRIBUTED_LOCK, useClass: RedisDistributedLock },
    OutboxRelay,
    OutboxReader,
  ],
  exports: [
    PrismaService,
    RedisPublisherProvider,
    DISTRIBUTED_LOCK,
    OutboxRelay,
    OutboxReader,
  ],
})
export class SharedModule {}
