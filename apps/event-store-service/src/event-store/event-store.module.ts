import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StoredEvent } from './entities/stored-event.entity';
import { EventStream } from './entities/event-stream.entity';
import { Snapshot } from './entities/snapshot.entity';
import { AppendIdempotency } from './entities/append-idempotency.entity';
import { LedgerCursor } from './entities/ledger-cursor.entity';
import { EventStoreService } from './services/event-store.service';
import { EventStoreController } from './event-store.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      StoredEvent,
      EventStream,
      Snapshot,
      AppendIdempotency,
      LedgerCursor,
    ]),
  ],
  controllers: [EventStoreController],
  providers: [EventStoreService],
  exports: [EventStoreService],
})
export class EventStoreModule {}
