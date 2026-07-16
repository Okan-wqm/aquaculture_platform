/**
 * FeedingProtocolModule — birleşik yemleme protokolü domain modülü.
 *
 * Faz 3 kapsamı: model + doğrulama/oran SSoT servisleri + CRUD/atama yüzeyi.
 * Yürütme motoru (day plan / meal üretimi) Faz 5'te bu modüle eklenir; legacy
 * FeedingModule motoru cutover'a (Faz 6) kadar dokunulmadan yaşar.
 *
 * @module FeedingProtocol
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FeedingProtocolV2 } from './entities/feeding-protocol-v2.entity';
import { ProtocolAssignment } from './entities/protocol-assignment.entity';
import { Feed } from '../feed/entities/feed.entity';
import { Species } from '../species/entities/species.entity';
import { ProtocolValidationService } from './services/protocol-validation.service';
import { ProtocolRateService } from './services/protocol-rate.service';
import {
  ArchiveFeedingProtocolV2Handler,
  CreateFeedingProtocolV2Handler,
  UpdateFeedingProtocolV2Handler,
} from './handlers/protocol-crud.handlers';
import {
  AssignProtocolToUnitHandler,
  UnassignProtocolHandler,
  UpdateProtocolAssignmentHandler,
} from './handlers/protocol-assignment.handlers';
import {
  GetFeedingProtocolV2Handler,
  ListFeedingProtocolsV2Handler,
  ListProtocolAssignmentsHandler,
} from './query-handlers/feeding-protocol-v2.query-handlers';
import { FeedingProtocolV2Resolver } from './resolvers/feeding-protocol-v2.resolver';

@Module({
  imports: [TypeOrmModule.forFeature([FeedingProtocolV2, ProtocolAssignment, Feed, Species])],
  providers: [
    ProtocolValidationService,
    ProtocolRateService,
    CreateFeedingProtocolV2Handler,
    UpdateFeedingProtocolV2Handler,
    ArchiveFeedingProtocolV2Handler,
    AssignProtocolToUnitHandler,
    UpdateProtocolAssignmentHandler,
    UnassignProtocolHandler,
    ListFeedingProtocolsV2Handler,
    GetFeedingProtocolV2Handler,
    ListProtocolAssignmentsHandler,
    FeedingProtocolV2Resolver,
  ],
  exports: [ProtocolValidationService, ProtocolRateService],
})
export class FeedingProtocolModule {}
