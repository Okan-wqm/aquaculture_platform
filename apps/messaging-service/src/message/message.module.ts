import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';

// Entities
import { Message } from './entities/message.entity';
import { MessageAttachment } from './entities/message-attachment.entity';
import { MessageReceipt } from './entities/message-receipt.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { PinnedMessage } from './entities/pinned-message.entity';
import { MessagingOutbox } from '../outbox/messaging-outbox.entity';

// Feature module dependencies
import { ChannelModule } from '../channel/channel.module';
import { PresenceModule } from '../presence/presence.module';
import { GdprModule } from '../gdpr/gdpr.module';

// Command handlers
import { CommandHandlers } from './commands';

// Query handlers
import { QueryHandlers } from './queries';

// Services
import { MessageService } from './services/message.service';
import { MediaService } from './services/media.service';
import { ThumbnailService } from './services/thumbnail.service';
import { StorageQuotaService } from './services/storage-quota.service';

// Resolver
import { MessageResolver } from './resolvers/message.resolver';

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
      MessageReaction,
      PinnedMessage,
      MessagingOutbox,
    ]),
    CqrsModule,
    ChannelModule,
    PresenceModule,
    GdprModule,
  ],
  providers: [
    // CQRS handlers
    ...CommandHandlers,
    ...QueryHandlers,

    // Domain services
    MessageService,
    MediaService,
    ThumbnailService,
    StorageQuotaService,

    // GraphQL resolver
    MessageResolver,
  ],
  exports: [MessageService, StorageQuotaService],
})
export class MessageModule {}
