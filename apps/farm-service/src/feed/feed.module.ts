/**
 * Feed Module
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { Feed } from './entities/feed.entity';
import { FeedSite } from './entities/feed-site.entity';
import { FeedTypeEntity } from './entities/feed-type.entity';
import { FeedTypeSpecies } from './entities/feed-type-species.entity';
import { FeedingProtocol } from './entities/feeding-protocol.entity';
import { Supplier } from '../supplier/entities/supplier.entity';
import { Site } from '../site/entities/site.entity';
import { Species } from '../species/entities/species.entity';

// Resolvers
import { FeedResolver } from './feed.resolver';
import { FeedingProtocolResolver } from './feeding-protocol.resolver';
import { FeedingProtocolSeederService } from './services/feeding-protocol-seeder.service';

import { RestoreModule } from '../common/services/restore.module';
// FinanceModule exports the currency SSoT resolver (FARM-HIGH-151).
import { FinanceModule } from '../finance/finance.module';

// Feed Command Handlers
import { CreateFeedHandler } from './handlers/create-feed.handler';
import { UpdateFeedHandler } from './handlers/update-feed.handler';
import { DeleteFeedHandler } from './handlers/delete-feed.handler';

// Feed Query Handlers
import { GetFeedHandler } from './handlers/get-feed.handler';
import { ListFeedsHandler } from './handlers/list-feeds.handler';

// Feeding Protocol Command Handlers
import { CreateFeedingProtocolHandler } from './handlers/create-feeding-protocol.handler';
import { UpdateFeedingProtocolHandler } from './handlers/update-feeding-protocol.handler';
import { DeleteFeedingProtocolHandler } from './handlers/delete-feeding-protocol.handler';

// Feeding Protocol Query Handlers
import { GetFeedingProtocolHandler } from './handlers/get-feeding-protocol.handler';
import { ListFeedingProtocolsHandler } from './handlers/list-feeding-protocols.handler';

const CommandHandlers = [
  // Feed
  CreateFeedHandler,
  UpdateFeedHandler,
  DeleteFeedHandler,
  // Feeding Protocol
  CreateFeedingProtocolHandler,
  UpdateFeedingProtocolHandler,
  DeleteFeedingProtocolHandler,
];

const QueryHandlers = [
  // Feed
  GetFeedHandler,
  ListFeedsHandler,
  // Feeding Protocol
  GetFeedingProtocolHandler,
  ListFeedingProtocolsHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Feed,
      FeedSite,
      FeedTypeEntity,
      FeedTypeSpecies,
      FeedingProtocol,
      Supplier,
      Site,
      Species,
    ]),
    RestoreModule,
    FinanceModule,
  ],
  providers: [
    FeedResolver,
    FeedingProtocolResolver,
    FeedingProtocolSeederService,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
  exports: [
    TypeOrmModule,
    FeedingProtocolSeederService,
  ],
})
export class FeedModule {}
