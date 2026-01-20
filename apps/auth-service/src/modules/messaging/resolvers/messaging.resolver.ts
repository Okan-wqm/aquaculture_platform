import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { MessagingService } from '../services/messaging.service';
import { JwtAuthGuard } from '../../authentication/guards/jwt-auth.guard';
import { TenantAdminOrHigher, CurrentUser } from '@platform/backend-common';
import { MessageThread, ThreadStatus } from '../entities/message-thread.entity';
import { Message } from '../entities/message.entity';
import {
  CreateThreadInput,
  SendMessageInput,
  ThreadListItem,
  MessageItem,
  MessagingStats,
} from '../dto/messaging.dto';

/**
 * MessagingResolver
 *
 * GraphQL resolver for messaging between SuperAdmin and TenantAdmin.
 */
@Resolver()
@UseGuards(JwtAuthGuard)
export class MessagingResolver {
  constructor(private readonly messagingService: MessagingService) {}

  // =========================================================
  // Queries
  // =========================================================

  /**
   * Get all threads for current user
   */
  @Query(() => [ThreadListItem])
  @TenantAdminOrHigher()
  async myThreads(
    @CurrentUser('sub') userId: string,
    @Args('status', { type: () => ThreadStatus, nullable: true })
    status?: ThreadStatus,
    @Args('search', { nullable: true }) search?: string,
  ): Promise<ThreadListItem[]> {
    return this.messagingService.getThreads(userId, { status, search });
  }

  /**
   * Get a single thread
   */
  @Query(() => MessageThread)
  @TenantAdminOrHigher()
  async thread(
    @CurrentUser('sub') userId: string,
    @Args('id', { type: () => ID }) threadId: string,
  ): Promise<MessageThread> {
    return this.messagingService.getThread(userId, threadId);
  }

  /**
   * Get messages in a thread
   */
  @Query(() => [MessageItem])
  @TenantAdminOrHigher()
  async threadMessages(
    @CurrentUser('sub') userId: string,
    @Args('threadId', { type: () => ID }) threadId: string,
  ): Promise<MessageItem[]> {
    return this.messagingService.getMessages(userId, threadId);
  }

  /**
   * Get messaging statistics
   */
  @Query(() => MessagingStats)
  @TenantAdminOrHigher()
  async messagingStats(
    @CurrentUser('sub') userId: string,
  ): Promise<MessagingStats> {
    return this.messagingService.getStats(userId);
  }

  // =========================================================
  // Mutations
  // =========================================================

  /**
   * Create a new thread
   */
  @Mutation(() => MessageThread)
  @TenantAdminOrHigher()
  async createThread(
    @CurrentUser('sub') userId: string,
    @Args('input') input: CreateThreadInput,
  ): Promise<MessageThread> {
    return this.messagingService.createThread(userId, input);
  }

  /**
   * Send a message
   */
  @Mutation(() => Message)
  @TenantAdminOrHigher()
  async sendMessage(
    @CurrentUser('sub') userId: string,
    @Args('input') input: SendMessageInput,
  ): Promise<Message> {
    return this.messagingService.sendMessage(userId, input);
  }

  /**
   * Close a thread
   */
  @Mutation(() => MessageThread)
  @TenantAdminOrHigher()
  async closeThread(
    @CurrentUser('sub') userId: string,
    @Args('threadId', { type: () => ID }) threadId: string,
  ): Promise<MessageThread> {
    return this.messagingService.closeThread(userId, threadId);
  }

  /**
   * Reopen a thread
   */
  @Mutation(() => MessageThread)
  @TenantAdminOrHigher()
  async reopenThread(
    @CurrentUser('sub') userId: string,
    @Args('threadId', { type: () => ID }) threadId: string,
  ): Promise<MessageThread> {
    return this.messagingService.reopenThread(userId, threadId);
  }

  /**
   * Archive a thread (SuperAdmin only)
   */
  @Mutation(() => MessageThread)
  @TenantAdminOrHigher()
  async archiveThread(
    @CurrentUser('sub') userId: string,
    @Args('threadId', { type: () => ID }) threadId: string,
  ): Promise<MessageThread> {
    return this.messagingService.archiveThread(userId, threadId);
  }
}
