import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { MessagingOutbox } from './messaging-outbox.entity';
import { OutboxWorkerService } from './outbox-worker.service';

/**
 * @module OutboxModule
 * @description Transactional outbox pattern for reliable event publishing.
 * Registers its own NATS_SERVICE client because NestJS ClientsModule.register()
 * is NOT global -- each module that injects NATS_SERVICE must import it.
 * @see ADR-012 section 7 (Outbox Pattern)
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([MessagingOutbox]),
    ClientsModule.register([
      {
        name: 'NATS_SERVICE',
        transport: Transport.NATS,
        options: {
          servers: [process.env['NATS_URL'] || 'nats://localhost:4222'],
        },
      },
    ]),
  ],
  providers: [OutboxWorkerService],
  exports: [OutboxWorkerService],
})
export class OutboxModule {}
