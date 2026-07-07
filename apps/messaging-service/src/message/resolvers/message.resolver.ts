import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  Int,
  ResolveField,
  Parent,
  ObjectType,
  Field,
  Directive,
  Context,
} from '@nestjs/graphql';
import { Logger, UseGuards, UseInterceptors, ForbiddenException, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import DataLoader from 'dataloader';
import GraphQLJSON from 'graphql-type-json';
import { MessagingRateLimit, MessagingRateLimitInterceptor } from '../../shared/interceptors/messaging-rate-limit.interceptor';
import { CurrentUser, CurrentUserPayload, Tenant } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';

import { Message } from '../entities/message.entity';
import { MessageAttachment } from '../entities/message-attachment.entity';
import { MessageReceipt } from '../entities/message-receipt.entity';
import { PinnedMessage } from '../entities/pinned-message.entity';
import { MessageReaction } from '../entities/message-reaction.entity';

// DTOs
import { SendMessageInput } from '../dto/send-message.input';
import { EditMessageInput } from '../dto/edit-message.input';
import { MessageFilterInput } from '../dto/message-filter.input';
import { RequestMediaUploadInput } from '../dto/request-media-upload.input';
import { MarkReadInput } from '../dto/mark-read.input';
import { SearchMessagesInput } from '../dto/search-messages.input';

// Commands
import { SendMessageCommand } from '../commands/send-message.command';
import { EditMessageCommand } from '../commands/edit-message.command';
import { DeleteMessageCommand } from '../commands/delete-message.command';
import { MarkReadCommand } from '../commands/mark-read.command';
import { ForwardMessageCommand } from '../commands/forward-message.command';

// Queries
import { GetMessagesQuery } from '../queries/get-messages.query';
import { GetMessagesSinceQuery } from '../queries/get-messages-since.query';
import { SearchMessagesQuery } from '../queries/search-messages.query';
import { MessagePage as MessagePageResult } from '../queries/get-messages.handler';

// Services
import { MessageService } from '../services/message.service';
import { MediaService, MediaUploadResult } from '../services/media.service';
import { StorageQuotaService } from '../services/storage-quota.service';
import { GdprService } from '../../gdpr/gdpr.service';
import { PresenceService } from '../../presence/presence.service';

// Repositories
import { DataSource, IsNull } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import {
  createBaseEvent,
  BaseEvent,
  AUTH_USER_QUERY_SUBJECTS,
  type ListTenantUserIdsQuery,
  type ListTenantUserIdsResult,
} from '@platform/event-contracts';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { ChannelMember, ChannelMemberRole } from '../../channel/entities/channel-member.entity';

// ============================================================================
// GRAPHQL TYPES
// ============================================================================

/**
 * Federated `User` entity (Apollo Federation v2, MSG-MEDIUM-052). auth-service is
 * the OWNER of the display fields (firstName/lastName/email/profileImageUrl); this
 * subgraph contributes ONLY the key (`id`) and the presence fields
 * (`isOnline`/`lastSeenAt`), which it resolves inline in resolveSender /
 * ChannelMember.resolveUser. The gateway stitches the display fields from auth's
 * federated User. Frontend `sender { firstName … }` now renders real names/avatars
 * instead of the previous placeholder nulls; `email` resolves null over a federated
 * reference (auth's reference resolver is display-only) but stays available on
 * auth's own admin-gated queries.
 */
@ObjectType()
@Directive('@key(fields: "id")')
export class User {
  @Field(() => ID)
  id: string;

  // Federation (MSG-MEDIUM-052): the display fields (firstName, lastName, email,
  // profileImageUrl) are NOT declared here — they are owned by auth-service's
  // federated User entity and stitched by the gateway via auth's __resolveReference
  // (display-only: email is never exposed cross-subgraph). messaging contributes
  // ONLY the key + the presence fields below, resolved INLINE by resolveSender /
  // ChannelMember.resolveUser (which carry @Tenant), so messaging needs no
  // reference resolver and no tenant-in-reference-resolver plumbing.

  /** Whether the user is currently online (messaging-owned, via PresenceService). */
  @Field(() => Boolean)
  isOnline: boolean;

  /** Last seen timestamp when user is offline. */
  @Field(() => Date, { nullable: true })
  lastSeenAt: Date | null;
}

/**
 * Cursor-paginated message list.
 */
@ObjectType()
export class MessagePageType {
  @Field(() => [Message])
  items: Message[];

  @Field(() => Boolean)
  hasMore: boolean;

  @Field(() => String, { nullable: true })
  cursor: string | null;
}

/**
 * Response for allMessagesSince (multi-channel offline sync).
 */
@ObjectType()
export class AllMessagesSinceResponse {
  @Field(() => [Message])
  messages: Message[];

  @Field(() => String, { nullable: true, description: 'Opaque sync token for next request' })
  syncToken: string | null;

  @Field(() => Boolean)
  hasMore: boolean;
}

/**
 * Response for requestMediaUpload mutation.
 */
@ObjectType()
export class MediaUploadResponse {
  @Field(() => String, { description: 'Presigned PUT URL' })
  uploadUrl: string;

  @Field(() => String, { description: 'Storage key to reference in sendMessage' })
  storageKey: string;

  @Field(() => Date, { description: 'URL expiration timestamp' })
  expiresAt: Date;
}

/**
 * Aggregated reaction summary per emoji on a message.
 * Computed from message_reactions table, grouped by emoji.
 */
@ObjectType()
export class ReactionSummary {
  /** The emoji string (e.g. thumbs-up unicode). */
  @Field(() => String)
  emoji: string;

  /** Total number of users who reacted with this emoji. */
  @Field(() => Int)
  count: number;

  /** User IDs who reacted with this emoji. */
  @Field(() => [String])
  userIds: string[];

  /** Whether the current requesting user has reacted with this emoji. */
  @Field(() => Boolean)
  hasReacted: boolean;
}

// ============================================================================
// RESOLVER
// ============================================================================

@Resolver(() => Message)
@UseGuards(TenantGuard)
@UseInterceptors(MessagingRateLimitInterceptor)
export class MessageResolver {
  private readonly logger = new Logger(MessageResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly messageService: MessageService,
    private readonly mediaService: MediaService,
    private readonly storageQuotaService: StorageQuotaService,
    private readonly gdprService: GdprService,
    private readonly presenceService: PresenceService,
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
  ) {}

  // -------------------------------------------------------------------------
  // QUERIES
  // -------------------------------------------------------------------------

  /**
   * Get messages for a channel with cursor-based pagination.
   */
  @Query(() => MessagePageType, { name: 'messages' })
  async getMessages(
    @Args('channelId', { type: () => ID }) channelId: string,
    @Args('filter', { type: () => MessageFilterInput, nullable: true }) filter: MessageFilterInput | undefined,
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<MessagePageType> {
    const limit = filter?.limit ?? 50;
    const result: MessagePageResult = await this.queryBus.execute(
      new GetMessagesQuery(
        tenantId,
        user.sub,
        channelId,
        limit,
        filter?.cursor ?? null,
        filter?.before ?? null,
        filter?.after ?? null,
      ),
    );
    return result;
  }

  /**
   * Offline sync: messages since a timestamp for a specific channel.
   */
  @Query(() => [Message], { name: 'messagesSince' })
  async getMessagesSince(
    @Args('channelId', { type: () => ID }) channelId: string,
    @Args('since', { type: () => Date }) since: Date,
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<Message[]> {
    return this.queryBus.execute(
      new GetMessagesSinceQuery(tenantId, user.sub, channelId, since),
    );
  }

  /**
   * Multi-channel offline sync: all new messages across all user's channels.
   */
  @Query(() => AllMessagesSinceResponse, { name: 'allMessagesSince' })
  async getAllMessagesSince(
    @Args('since', { type: () => Date }) since: Date,
    @Args('limit', { type: () => Int, defaultValue: 200 }) limit: number,
    @Args('syncToken', { type: () => String, nullable: true }) syncToken: string | undefined,
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<AllMessagesSinceResponse> {
    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      const memberships = await queryRunner.manager
        .createQueryBuilder(ChannelMember, 'cm')
        .innerJoin('channels', 'c', 'c."tenantId" = :tenantId AND c."id" = cm."channelId"', { tenantId })
        .where('cm."tenantId" = :tenantId', { tenantId })
        .andWhere('cm."userId" = :userId', { userId: user.sub })
        .andWhere('cm."leftAt" IS NULL')
        .andWhere('c."isArchived" = false')
        .select('cm."channelId"', 'channelId')
        .getRawMany<{ channelId: string }>();
      const channelIds = memberships.map((m) => m.channelId);

      if (channelIds.length === 0) {
        return { messages: [], syncToken: null, hasMore: false };
      }

      // Parse sync token for cursor-based continuation
      let cursorDate = since;
      let cursorId: string | null = null;
      if (syncToken) {
        try {
          const decoded = JSON.parse(
            Buffer.from(syncToken, 'base64url').toString('utf-8'),
          ) as { createdAt: string; id: string };
          cursorDate = new Date(decoded.createdAt);
          cursorId = decoded.id;
        } catch {
          this.logger.warn('Invalid sync token, falling back to since param');
        }
      }

      const cappedLimit = Math.min(limit, 500);

      const qb = queryRunner.manager
        .createQueryBuilder(Message, 'm')
        .leftJoinAndSelect('m.attachments', 'att')
        .where('m."tenantId" = :tenantId', { tenantId })
        .andWhere('m."channelId" IN (:...channelIds)', { channelIds })
        .andWhere('m."isDeleted" = false');

      if (cursorId) {
        // MSG-HIGH-067: composite (createdAt, id) keyset — the ONLY cursor clause.
        // The previous code ALSO applied an unconditional `createdAt > :cursorDate`,
        // which subsumed the `createdAt = cursorDate AND id > cursorId` branch (the
        // outer AND already required a strictly-greater timestamp), so every message
        // sharing the cursor's exact timestamp was silently and permanently dropped
        // from the sync delta. Mirrors the get-messages.handler keyset (no redundant
        // strict clause).
        qb.andWhere(
          '(m."createdAt" > :cursorDate OR (m."createdAt" = :cursorDate AND m."id" > :cursorId))',
          { cursorDate, cursorId },
        );
      } else {
        // First page from the `since` watermark — the boundary is exclusive.
        qb.andWhere('m."createdAt" > :cursorDate', { cursorDate });
      }

      qb.orderBy('m.createdAt', 'ASC')
        .addOrderBy('m.id', 'ASC')
        .take(cappedLimit + 1);

      const messages = await qb.getMany();
      const hasMore = messages.length > cappedLimit;
      const items = hasMore ? messages.slice(0, cappedLimit) : messages;

      let nextSyncToken: string | null = null;
      if (items.length > 0) {
        const last = items[items.length - 1]!;
        nextSyncToken = Buffer.from(
          JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
        ).toString('base64url');
      }

      return { messages: items, syncToken: nextSyncToken, hasMore };
    });
  }

  /**
   * Get total unread message count across all channels.
   */
  @Query(() => Int, { name: 'totalUnreadMessageCount' })
  async getTotalUnreadMessageCount(
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<number> {
    return this.messageService.getUnreadCount(user.sub, tenantId);
  }

  /**
   * Full-text search across messages.
   */
  @Query(() => [Message], { name: 'searchMessages' })
  async searchMessages(
    @Args('input') input: SearchMessagesInput,
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<Message[]> {
    return this.queryBus.execute(
      new SearchMessagesQuery(
        tenantId,
        user.sub,
        input.query,
        input.channelId ?? null,
        input.limit,
      ),
    );
  }

  /**
   * Get pinned messages for a channel.
   */
  @Query(() => [PinnedMessage], { name: 'pinnedMessages' })
  async getPinnedMessages(
    @Args('channelId', { type: () => ID }) channelId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<PinnedMessage[]> {
    // Validate membership
    await this.validateChannelMembership(tenantId, channelId, user.sub);

    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) =>
      queryRunner.manager.find(PinnedMessage, {
        where: { tenantId, channelId },
        relations: ['message'],
        order: { pinnedAt: 'DESC' },
      }),
    );
  }

  /**
   * Get presence info for a list of users.
   */
  @Query(() => [User], { name: 'userPresence' })
  async getUserPresence(
    @Args('userIds', { type: () => [ID] }) userIds: string[],
    @Tenant() tenantId: string,
  ): Promise<User[]> {
    const onlineMap = await this.presenceService.getOnlineUsers(tenantId, userIds);
    const results: User[] = [];
    for (const id of userIds) {
      const isOnline = onlineMap.get(id) ?? false;
      const lastSeenAt = isOnline ? null : await this.presenceService.getLastSeen(tenantId, id);
      results.push({ id, isOnline, lastSeenAt });
    }
    return results;
  }

  /**
   * Tenant users the caller can start a chat with — the New Chat picker source
   * (MSG-HIGH-051). Open to ANY messaging user (the resolver is
   * @UseGuards(TenantGuard)), unlike auth's admin-gated `tenantUsers` (which
   * 403'd field workers). Enumerates the tenant via the IDs-only auth NATS query
   * (no PII over NATS), excludes the caller, and returns the federated `User`
   * (id + presence inline; display name/avatar stitched from auth, display-only),
   * so the picker shows real people without a profile-harvesting oracle.
   */
  @Query(() => [User], { name: 'channelEligibleUsers' })
  async channelEligibleUsers(
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<User[]> {
    let result: ListTenantUserIdsResult | undefined;
    try {
      result = await firstValueFrom(
        this.natsClient
          .send<ListTenantUserIdsResult, ListTenantUserIdsQuery>(
            AUTH_USER_QUERY_SUBJECTS.LIST_TENANT_USER_IDS,
            { tenantId },
          )
          .pipe(timeout(5000)),
      );
    } catch (error) {
      this.logger.warn(
        `channelEligibleUsers: tenant user list failed: ${(error as Error).message}`,
      );
      return [];
    }
    if (!result?.success) {
      return [];
    }
    const eligibleIds = result.userIds.filter((id) => id !== user.sub);
    return this.batchLoadUsers(eligibleIds, tenantId);
  }

  // -------------------------------------------------------------------------
  // MUTATIONS
  // -------------------------------------------------------------------------

  /**
   * Send a new message to a channel.
   */
  @Mutation(() => Message, { name: 'sendMessage' })
  @MessagingRateLimit('sendMessage')
  async sendMessage(
    @Args('input') input: SendMessageInput,
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<Message> {
    // Validate channel membership before sending
    await this.validateChannelMembership(tenantId, input.channelId, user.sub);

    const message: Message = await this.commandBus.execute(
      new SendMessageCommand(
        tenantId,
        user.sub,
        input.channelId,
        input.content ?? null,
        input.contentType,
        input.idempotencyKey,
        input.parentId ?? null,
        input.attachmentKeys ?? [],
        input.metadata ?? null,
      ),
    );

    // MSG-HIGH-066: unread is computed from the DB on read (single authority);
    // no Redis HASH increment on send — the previous counter only ever grew.

    return message;
  }

  /**
   * Edit a message's content (owner only).
   */
  @Mutation(() => Message, { name: 'editMessage' })
  @MessagingRateLimit('editMessage')
  async editMessage(
    @Args('id', { type: () => ID }) messageId: string,
    @Args('input') input: EditMessageInput,
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<Message> {
    return this.commandBus.execute(
      new EditMessageCommand(tenantId, user.sub, messageId, input.content),
    );
  }

  /**
   * Delete a message (soft-delete). Owner or channel admin/owner.
   */
  @Mutation(() => Boolean, { name: 'deleteMessage' })
  @MessagingRateLimit('deleteMessage')
  async deleteMessage(
    @Args('id', { type: () => ID }) messageId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    // Get the message to find its channel, then check user's role
    const membership = await runInTenantTransaction(
      this.dataSource,
      'messaging',
      tenantId,
      async (queryRunner) => {
        const message = await queryRunner.manager.findOne(Message, {
          where: { tenantId, id: messageId },
        });
        if (!message) {
          throw new NotFoundException(`Message ${messageId} not found.`);
        }

        return queryRunner.manager.findOne(ChannelMember, {
          where: { tenantId, channelId: message.channelId, userId: user.sub, leftAt: IsNull() },
        });
      },
    );

    return this.commandBus.execute(
      new DeleteMessageCommand(
        tenantId,
        user.sub,
        messageId,
        membership?.role ?? null,
      ),
    );
  }

  /**
   * Mark messages as read up to a specific message.
   */
  @Mutation(() => Boolean, { name: 'markMessagesRead' })
  async markMessagesRead(
    @Args('input') input: MarkReadInput,
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    return this.commandBus.execute(
      new MarkReadCommand(tenantId, user.sub, input.channelId, input.messageId),
    );
  }

  /**
   * Request a presigned URL for media upload.
   */
  @Mutation(() => MediaUploadResponse, { name: 'requestMediaUpload' })
  @MessagingRateLimit('uploadMedia')
  async requestMediaUpload(
    @Args('input') input: RequestMediaUploadInput,
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<MediaUploadResponse> {
    await this.validateChannelMembership(tenantId, input.channelId, user.sub);

    // Enforce storage quota before generating presigned URL
    await this.storageQuotaService.enforceQuota(tenantId, input.fileSize);

    const result: MediaUploadResult = await this.mediaService.generateUploadUrl(
      tenantId,
      input.channelId,
      input.filename,
      input.mimeType,
    );

    // Invalidate storage cache after generating upload URL
    this.storageQuotaService.invalidateCache(tenantId).catch((err: Error) => {
      this.logger.warn(`Failed to invalidate storage cache: ${err.message}`);
    });

    return {
      uploadUrl: result.uploadUrl,
      storageKey: result.storageKey,
      expiresAt: result.expiresAt,
    };
  }

  /**
   * Pin a message in a channel (admin/owner only).
   */
  @Mutation(() => PinnedMessage, { name: 'pinMessage' })
  @MessagingRateLimit('pinMessage')
  async pinMessage(
    @Args('channelId', { type: () => ID }) channelId: string,
    @Args('messageId', { type: () => ID }) messageId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<PinnedMessage> {
    const membership = await this.validateChannelMembership(tenantId, channelId, user.sub);
    if (
      membership.role !== ChannelMemberRole.ADMIN &&
      membership.role !== ChannelMemberRole.OWNER
    ) {
      throw new ForbiddenException('Only ADMIN or OWNER can pin messages.');
    }

    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      const { manager } = queryRunner;
      const message = await manager.findOne(Message, {
        where: { tenantId, id: messageId, channelId, isDeleted: false },
      });
      if (!message) {
        throw new NotFoundException(`Message ${messageId} not found.`);
      }

      // Check if already pinned
      const existing = await manager.findOne(PinnedMessage, {
        where: { tenantId, channelId, messageId },
      });
      if (existing) {
        return existing;
      }

      const pinned = manager.create(PinnedMessage, {
        tenantId,
        channelId,
        messageId,
        messageCreatedAt: message.createdAt,
        pinnedBy: user.sub,
      });
      const savedPin = await manager.save(PinnedMessage, pinned);

      await this.outboxPublisher.enqueue({
        ...createBaseEvent('MessagePinned', tenantId),
        channelId,
        messageId,
        pinnedBy: user.sub,
      },  manager);

      return savedPin;
    });
  }

  /**
   * Unpin a message from a channel.
   */
  @Mutation(() => Boolean, { name: 'unpinMessage' })
  @MessagingRateLimit('unpinMessage')
  async unpinMessage(
    @Args('channelId', { type: () => ID }) channelId: string,
    @Args('messageId', { type: () => ID }) messageId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    const membership = await this.validateChannelMembership(tenantId, channelId, user.sub);
    if (
      membership.role !== ChannelMemberRole.ADMIN &&
      membership.role !== ChannelMemberRole.OWNER
    ) {
      throw new ForbiddenException('Only ADMIN or OWNER can unpin messages.');
    }

    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      const { manager } = queryRunner;
      const result = await manager.delete(PinnedMessage, { tenantId, channelId, messageId });
      if ((result.affected ?? 0) > 0) {
        await this.outboxPublisher.enqueue({
          ...createBaseEvent('MessageUnpinned', tenantId),
          channelId,
          messageId,
          unpinnedBy: user.sub,
        },  manager);
      }
      return (result.affected ?? 0) > 0;
    });
  }

  /**
   * Add an emoji reaction to a message.
   */
  @Mutation(() => Boolean, { name: 'addReaction' })
  @MessagingRateLimit('addReaction')
  async addReaction(
    @Args('messageId', { type: () => ID }) messageId: string,
    @Args('emoji', { type: () => String }) emoji: string,
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    if (!emoji || emoji.length > 32) {
      throw new BadRequestException('Emoji must be between 1 and 32 characters.');
    }
    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      const { manager } = queryRunner;
      const message = await manager.findOne(Message, {
        where: { tenantId, id: messageId, isDeleted: false },
      });
      if (!message) {
        throw new NotFoundException(`Message ${messageId} not found.`);
      }

      const membership = await manager.findOne(ChannelMember, {
        where: { tenantId, channelId: message.channelId, userId: user.sub, leftAt: IsNull() },
      });
      if (!membership) {
        throw new ForbiddenException('You are not a member of this channel.');
      }

      // Upsert reaction (unique constraint on messageId + userId + emoji)
      const existing = await manager.findOne(MessageReaction, {
        where: { tenantId, messageId, userId: user.sub, emoji },
      });
      if (existing) {
        return true; // Already reacted with this emoji
      }

      const reaction = manager.create(MessageReaction, {
        tenantId,
        messageId,
        messageCreatedAt: message.createdAt,
        userId: user.sub,
        emoji,
      });
      await manager.save(MessageReaction, reaction);

      await this.outboxPublisher.enqueue({
        ...createBaseEvent('ReactionAdded', tenantId),
        channelId: message.channelId,
        messageId,
        userId: user.sub,
        emoji,
      },  manager);

      return true;
    });
  }

  /**
   * Remove an emoji reaction from a message.
   */
  @Mutation(() => Boolean, { name: 'removeReaction' })
  @MessagingRateLimit('removeReaction')
  async removeReaction(
    @Args('messageId', { type: () => ID }) messageId: string,
    @Args('emoji', { type: () => String }) emoji: string,
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      const { manager } = queryRunner;
      const message = await manager.findOne(Message, {
        where: { tenantId, id: messageId, isDeleted: false },
      });
      if (!message) {
        throw new NotFoundException(`Message ${messageId} not found.`);
      }

      const membership = await manager.findOne(ChannelMember, {
        where: { tenantId, channelId: message.channelId, userId: user.sub, leftAt: IsNull() },
      });
      if (!membership) {
        throw new ForbiddenException('You are not a member of this channel.');
      }

      const result = await manager.delete(MessageReaction, {
        tenantId,
        messageId,
        userId: user.sub,
        emoji,
      });
      if ((result.affected ?? 0) > 0) {
        await this.outboxPublisher.enqueue({
          ...createBaseEvent('ReactionRemoved', tenantId),
          messageId,
          userId: user.sub,
          emoji,
        },  manager);
      }
      return (result.affected ?? 0) > 0;
    });
  }

  /**
   * Forward a message to another channel.
   * User must be a member of both the source and target channels.
   */
  @Mutation(() => Message, { name: 'forwardMessage' })
  @MessagingRateLimit('forwardMessage')
  async forwardMessage(
    @Args('sourceMessageId', { type: () => ID }) sourceMessageId: string,
    @Args('sourceMessageCreatedAt', { type: () => Date }) sourceMessageCreatedAt: Date,
    @Args('targetChannelId', { type: () => ID }) targetChannelId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<Message> {
    const message: Message = await this.commandBus.execute(
      new ForwardMessageCommand(
        tenantId,
        user.sub,
        sourceMessageId,
        sourceMessageCreatedAt,
        targetChannelId,
      ),
    );

    // MSG-HIGH-066: unread is DB-authoritative on read; no HASH increment on forward.

    return message;
  }

  /**
   * GDPR: Export all user's messages as JSON.
   * Delegates to GdprService which includes rate limiting and full export.
   */
  @Mutation(() => GraphQLJSON, { name: 'exportMyMessages' })
  async exportMyMessages(
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<Record<string, unknown>> {
    const exported = await this.gdprService.exportMyMessages(user.sub, tenantId);
    return {
      exportedAt: new Date().toISOString(),
      userId: user.sub,
      messageCount: exported.messages.length,
      ...exported,
    };
  }

  /**
   * GDPR: Anonymize user's data (requires password confirmation).
   * Delegates to GdprService which verifies password via auth-service
   * and performs full transactional anonymisation.
   */
  @Mutation(() => Boolean, { name: 'anonymizeMyData' })
  @MessagingRateLimit('anonymizeMyData')
  async anonymizeMyData(
    @Args('confirmPassword', { type: () => String }) confirmPassword: string,
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    return this.gdprService.anonymizeMyData(user.sub, tenantId, confirmPassword);
  }

  // -------------------------------------------------------------------------
  // FIELD RESOLVERS
  // -------------------------------------------------------------------------

  /**
   * Resolve the sender field for a Message via request-scoped batched DataLoader.
   * Creates the DataLoader lazily on first access per request context.
   */
  @ResolveField(() => User, { name: 'sender', nullable: true })
  async resolveSender(
    @Parent() message: Message,
    @Tenant() tenantId: string,
    @Context() ctx: { userLoader?: DataLoader<string, User> },
  ): Promise<User> {
    if (!ctx.userLoader) {
      ctx.userLoader = new DataLoader<string, User>(
        async (userIds: readonly string[]) => {
          return this.batchLoadUsers([...userIds], tenantId);
        },
        { cache: true },
      );
    }
    return ctx.userLoader.load(message.senderId);
  }

  /**
   * Resolve attachment download URLs.
   * Generates presigned download URLs for each attachment.
   */
  @ResolveField(() => [MessageAttachment], { name: 'attachments' })
  async resolveAttachments(
    @Parent() message: Message,
    @Tenant() tenantId: string,
  ): Promise<MessageAttachment[]> {
    if (message.attachments && message.attachments.length > 0) {
      return message.attachments;
    }

    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) =>
      queryRunner.manager.find(MessageAttachment, {
        where: {
          tenantId,
          messageId: message.id,
          messageCreatedAt: message.createdAt,
          isDeleted: false,
        },
        order: { createdAt: 'ASC' },
      }),
    );
  }

  /**
   * Resolve read receipts for a message.
   * Returns delivery/read tracking data for each recipient.
   */
  @ResolveField(() => [MessageReceipt], { name: 'receipts', nullable: true, description: 'Read/delivery receipts for this message' })
  async resolveReceipts(
    @Parent() message: Message,
    @Tenant() tenantId: string,
  ): Promise<MessageReceipt[]> {
    if (message.receipts && message.receipts.length > 0) {
      return message.receipts;
    }

    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) =>
      queryRunner.manager.find(MessageReceipt, {
        where: {
          tenantId,
          messageId: message.id,
          messageCreatedAt: message.createdAt,
        },
        order: { receiptCreatedAt: 'ASC' },
      }),
    );
  }

  /**
   * Resolve aggregated reaction summary for a message.
   * Groups reactions by emoji, counts unique users, and checks if the
   * requesting user has reacted with each emoji.
   */
  @ResolveField(() => [ReactionSummary], { name: 'reactionSummary', nullable: true, description: 'Aggregated emoji reaction counts' })
  async resolveReactionSummary(
    @Parent() message: Message,
    @CurrentUser() user: CurrentUserPayload,
    @Tenant() tenantId: string,
  ): Promise<ReactionSummary[]> {
    const reactions = await runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) =>
      queryRunner.manager.find(MessageReaction, {
        where: { tenantId, messageId: message.id },
      }),
    );

    if (reactions.length === 0) return [];

    // Group by emoji
    const emojiMap = new Map<string, string[]>();
    for (const reaction of reactions) {
      const userIds = emojiMap.get(reaction.emoji) ?? [];
      userIds.push(reaction.userId);
      emojiMap.set(reaction.emoji, userIds);
    }

    const summaries: ReactionSummary[] = [];
    for (const [emoji, userIds] of emojiMap) {
      summaries.push({
        emoji,
        count: userIds.length,
        userIds,
        hasReacted: userIds.includes(user.sub),
      });
    }

    return summaries;
  }

  // -------------------------------------------------------------------------
  // PRIVATE HELPERS
  // -------------------------------------------------------------------------

  /**
   * Validate that a user is an active member of a channel.
   * @throws ForbiddenException if not a member
   */
  private async validateChannelMembership(
    tenantId: string,
    channelId: string,
    userId: string,
  ): Promise<ChannelMember> {
    const membership = await runInTenantTransaction(
      this.dataSource,
      'messaging',
      tenantId,
      async (queryRunner) => queryRunner.manager.findOne(ChannelMember, {
        where: { tenantId, channelId, userId },
      }),
    );
    if (!membership || membership.leftAt !== null) {
      throw new ForbiddenException('You are not a member of this channel.');
    }
    return membership;
  }

  /**
   * Batch load the messaging-owned User fields for the DataLoader (MSG-MEDIUM-052).
   * messaging contributes ONLY id + presence; the gateway stitches the display
   * fields (firstName/lastName/profileImageUrl) from auth-service's federated User.
   */
  private async batchLoadUsers(userIds: string[], tenantId: string): Promise<User[]> {
    const onlineMap = await this.presenceService.getOnlineUsers(tenantId, userIds);
    return Promise.all(
      userIds.map(async (id) => {
        const isOnline = onlineMap.get(id) ?? false;
        const lastSeenAt = isOnline
          ? null
          : await this.presenceService.getLastSeen(tenantId, id);
        return { id, isOnline, lastSeenAt };
      }),
    );
  }
}
