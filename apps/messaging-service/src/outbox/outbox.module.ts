import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessagingOutbox } from './messaging-outbox.entity';
import { OutboxWorkerService } from './outbox-worker.service';

/**
 * @module OutboxModule
 * @description Transactional outbox pattern for reliable event publishing.
 * NATS_SERVICE is provided globally via AppModule's ClientsModule registration.
 * @see ADR-012 section 7 (Outbox Pattern)
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([MessagingOutbox]),
  ],
  providers: [OutboxWorkerService],
  exports: [OutboxWorkerService],
})
export class OutboxModule {}
