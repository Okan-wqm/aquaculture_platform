/**
 * Feeding Module
 *
 * Yemleme yönetimi ve FCR hesaplamaları.
 * Günlük yemleme programları ve kayıtları.
 *
 * Sağladığı özellikler:
 * - FCR bazlı yemleme tabloları
 * - Günlük yemleme kayıtları
 * - Planlanan vs Gerçekleşen takibi
 * - Çevresel koşul kayıtları
 * - Balık davranışı gözlemleri
 *
 * @module Feeding
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@platform/cqrs';

// Entities
import { FeedingTable } from './entities/feeding-table.entity';
import { FeedingRecord } from './entities/feeding-record.entity';
import { FeedInventory } from './entities/feed-inventory.entity';

// Related entities
import { Batch } from '../batch/entities/batch.entity';
import { Feed } from '../feed/entities/feed.entity';
import { Tank } from '../tank/entities/tank.entity';
import { Site } from '../site/entities/site.entity';

// Handlers
import { FeedingCommandHandlers } from './handlers';
import { FeedingQueryHandlers } from './query-handlers';

// Resolvers
import { FeedingResolvers } from './resolvers';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      FeedingTable,
      FeedingRecord,
      FeedInventory,
      Batch,
      Feed,
      Tank,
      Site,
    ]),
    CqrsModule,
  ],
  providers: [
    ...FeedingCommandHandlers,
    ...FeedingQueryHandlers,
    ...FeedingResolvers,
  ],
  exports: [
    TypeOrmModule,
  ],
})
export class FeedingModule {}
