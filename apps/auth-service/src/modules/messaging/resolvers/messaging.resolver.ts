import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { TenantAdminOrHigher, SuperAdminOnly, CurrentUser } from '@aquaculture/backend-common/decorators';
import {
  CreateThreadInput,
  SendMessageInput,
  ThreadListItem,
  MessageItem,
  MessagingStats,
  BulkMessageInput,
  BulkMessageResult,
} from '../dto/messaging.dto';
import { MessageThread, ThreadStatus } from '../entities/message-thread.entity';
import { Message } from '../entities/message.entity';
import { MessagingService } from '../services/messaging.service';

/**
 * MessagingResolver
 *
 * GraphQL resolver for admin-to-tenant support messaging.
 * All query/mutation names prefixed with 'support' to avoid Apollo Federation
 * conflicts with messaging-service's tenant-internal channel messaging.
 */
@Resolver()
export class MessagingResolver {
  constructor(private readonly messagingService: MessagingService) {}

  // =========================================================
  // Queries
  // =========================================================

  /**
   * Get all support threads for current user
   */
  @Query(() => [ThreadListItem], { name: 'mySupportThreads' })
  @TenantAdminOrHigher()
  async mySupportThreads(
    @CurrentUser('sub') userId: string,
    @Args('status', { type: () => ThreadStatus, nullable: true })
    status?: ThreadStatus,
    @Args('search', { nullable: true }) search?: string,
  ): Promise<ThreadListItem[]> {
    return this.messagingService.getThreads(userId, { status, search });
  }

  /**
   * Get a single support thread
   */
  @Query(() => MessageThread, { name: 'supportThread' })
  @TenantAdminOrHigher()
  async supportThread(
    @CurrentUser('sub') userId: string,
    @Args('id', { type: () => ID }) threadId: string,
  ): Promise<MessageThread> {
    return this.messagingService.getThread(userId, threadId);
  }

  /**
   * Get messages in a support thread
   */
  @Query(() => [MessageItem], { name: 'supportThreadMessages' })
  @TenantAdminOrHigher()
  async supportThreadMessages(
    @CurrentUser('sub') userId: string,
    @Args('threadId', { type: () => ID }) threadId: string,
  ): Promise<MessageItem[]> {
    return this.messagingService.getMessages(userId, threadId);
  }

  /**
   * Get support messaging statistics
   */
  @Query(() => MessagingStats, { name: 'supportMessagingStats' })
  @TenantAdminOrHigher()
  async supportMessagingStats(
    @CurrentUser('sub') userId: string,
  ): Promise<MessagingStats> {
    return this.messagingService.getStats(userId);
  }

  // =========================================================
  // Mutations
  // =========================================================

  /**
   * Create a new support thread
   */
  @Mutation(() => MessageThread, { name: 'createSupportThread' })
  @TenantAdminOrHigher()
  async createSupportThread(
    @CurrentUser('sub') userId: string,
    @Args('input') input: CreateThreadInput,
  ): Promise<MessageThread> {
    return this.messagingService.createThread(userId, input);
  }

  /**
   * Send a support message
   */
  @Mutation(() => Message, { name: 'sendSupportMessage' })
  @TenantAdminOrHigher()
  async sendSupportMessage(
    @CurrentUser('sub') userId: string,
    @Args('input') input: SendMessageInput,
  ): Promise<Message> {
    return this.messagingService.sendMessage(userId, input);
  }

  /**
   * Close a support thread
   */
  @Mutation(() => MessageThread, { name: 'closeSupportThread' })
  @TenantAdminOrHigher()
  async closeSupportThread(
    @CurrentUser('sub') userId: string,
    @Args('threadId', { type: () => ID }) threadId: string,
  ): Promise<MessageThread> {
    return this.messagingService.closeThread(userId, threadId);
  }

  /**
   * Reopen a support thread
   */
  @Mutation(() => MessageThread, { name: 'reopenSupportThread' })
  @TenantAdminOrHigher()
  async reopenSupportThread(
    @CurrentUser('sub') userId: string,
    @Args('threadId', { type: () => ID }) threadId: string,
  ): Promise<MessageThread> {
    return this.messagingService.reopenThread(userId, threadId);
  }

  /**
   * Archive a support thread (SuperAdmin only)
   */
  @Mutation(() => MessageThread, { name: 'archiveSupportThread' })
  @SuperAdminOnly()
  async archiveSupportThread(
    @CurrentUser('sub') userId: string,
    @Args('threadId', { type: () => ID }) threadId: string,
  ): Promise<MessageThread> {
    return this.messagingService.archiveThread(userId, threadId);
  }

  /**
   * Open a support thread for every active tenant (SuperAdmin only).
   */
  @Mutation(() => BulkMessageResult, { name: 'sendBulkSupportMessage' })
  @SuperAdminOnly()
  async sendBulkSupportMessage(
    @CurrentUser('sub') userId: string,
    @Args('input') input: BulkMessageInput,
  ): Promise<BulkMessageResult> {
    return this.messagingService.sendBulkSupportMessage(userId, input);
  }
}
