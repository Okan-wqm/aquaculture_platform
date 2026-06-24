import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { ClientsModule } from '@nestjs/microservices';
import { NatsV3Client } from '@aquaculture/backend-common/nats';

// Entities
import { Message } from './entities/message.entity';
import { MessageAttachment } from './entities/message-attachment.entity';
import { MessageReceipt } from './entities/message-receipt.entity';
import { MessageReceiptLedger } from './entities/message-receipt-ledger.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { PinnedMessage } from './entities/pinned-message.entity';
// Feature module dependencies
import { ChannelModule } from '../channel/channel.module';
import { PresenceModule } from '../presence/presence.module';
import { GdprModule } from '../gdpr/gdpr.module';
// ComplianceModule imported: DeleteMessageHandler now calls LegalHoldService.isUnderLegalHold()
// before soft-deleting messages. ComplianceModule exports LegalHoldService.
import { ComplianceModule } from '../compliance/compliance.module';

// Command handlers
import { CommandHandlers } from './commands';

// Query handlers
import { QueryHandlers } from './queries';

// Services
import { MessageService } from './services/message.service';
import { IdempotencyLedgerGcService } from './services/idempotency-ledger-gc.service';
import { MediaService } from './services/media.service';
import { S3StorageObjectVerifier } from './services/s3-storage-object-verifier.service';
import { STORAGE_OBJECT_VERIFIER } from './services/storage-object-verifier.port';
import { MentionService } from './services/mention.service';
import { ThumbnailService } from './services/thumbnail.service';
import { MediaFinalizationService } from './services/media-finalization.service';
import { StorageQuotaService } from './services/storage-quota.service';

// Resolver
import { MessageResolver } from './resolvers/message.resolver';
import { MessageAttachmentResolver } from './resolvers/message-attachment.resolver';

/**
 * @module MessageModule
 * @description CQRS-based messaging with commands, queries,
 * services, and GraphQL resolver for the messaging domain.
 * @see ADR-012 section 4 (Message domain)
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Message,
      MessageAttachment,
      MessageReceipt,
      MessageReceiptLedger,
      MessageReaction,
      PinnedMessage,
    ]),
    CqrsModule,
    /** SEC-H01: NATS client with shared auth factory. */
    ClientsModule.register([
      {
        name: 'NATS_SERVICE',
        customClass: NatsV3Client,
        options: { serviceName: 'messaging-service' },
      },
    ]),
    ChannelModule,
    PresenceModule,
    GdprModule,
    ComplianceModule,
  ],
  providers: [
    IdempotencyLedgerGcService,
    // CQRS handlers
    ...CommandHandlers,
    ...QueryHandlers,

    // Domain services
    MessageService,
    MediaService,
    S3StorageObjectVerifier,
    {
      provide: STORAGE_OBJECT_VERIFIER,
      useExisting: S3StorageObjectVerifier,
    },
    MentionService,
    ThumbnailService,
    MediaFinalizationService,
    StorageQuotaService,

    // GraphQL resolvers
    MessageResolver,
    MessageAttachmentResolver,
  ],
  exports: [MessageService, StorageQuotaService, MediaService],
})
export class MessageModule {}
