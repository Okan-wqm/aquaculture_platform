/**
 * Feed Module
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';

// Entities
import { Feed } from './entities/feed.entity';
import { FeedSite } from './entities/feed-site.entity';
import { FeedTypeEntity } from './entities/feed-type.entity';
import { FeedTypeSpecies } from './entities/feed-type-species.entity';
import { FeedingProtocol } from './entities/feeding-protocol.entity';
import { Supplier } from '../supplier/entities/supplier.entity';
import { Site } from '../site/entities/site.entity';
import { Species } from '../species/entities/species.entity';

// Resolver
import { FeedResolver } from './feed.resolver';

// Command Handlers
import { CreateFeedHandler } from './handlers/create-feed.handler';
import { UpdateFeedHandler } from './handlers/update-feed.handler';
import { DeleteFeedHandler } from './handlers/delete-feed.handler';

// Query Handlers
import { GetFeedHandler } from './handlers/get-feed.handler';
import { ListFeedsHandler } from './handlers/list-feeds.handler';

const CommandHandlers = [
  CreateFeedHandler,
  UpdateFeedHandler,
  DeleteFeedHandler,
];

const QueryHandlers = [
  GetFeedHandler,
  ListFeedsHandler,
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
    CqrsModule,
  ],
  providers: [
    FeedResolver,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
  exports: [
    TypeOrmModule,
  ],
})
export class FeedModule {}
