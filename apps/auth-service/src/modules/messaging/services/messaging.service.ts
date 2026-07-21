import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Role } from '@aquaculture/backend-common/decorators';
import { Repository } from 'typeorm';

import { User } from '../../authentication/entities/user.entity';
import { Tenant, TenantStatus } from '../../tenant/entities/tenant.entity';
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
import { Message, SenderType, MessageStatus } from '../entities/message.entity';

/**
 * MessagingService
 *
 * Handles messaging between SuperAdmin and TenantAdmin.
 * Thread-based conversations with internal notes support.
 */
@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    @InjectRepository(MessageThread)
    private readonly threadRepository: Repository<MessageThread>,
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  // =========================================================
  // Thread Operations
  // =========================================================

  /**
   * Get threads for a user (filtered by role)
   */
  async getThreads(
    userId: string,
    filters?: { status?: ThreadStatus; search?: string },
  ): Promise<ThreadListItem[]> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const query = this.threadRepository
      .createQueryBuilder('thread')
      .leftJoinAndSelect('thread.tenant', 'tenant')
      .orderBy('thread.updatedAt', 'DESC');

    // TenantAdmin sees only their tenant's threads
    if (user.role === Role.TENANT_ADMIN && user.tenantId) {
      query.where('thread.tenantId = :tenantId', { tenantId: user.tenantId });
    }

    // Apply filters
    if (filters?.status) {
      query.andWhere('thread.status = :status', { status: filters.status });
    }

    if (filters?.search) {
      query.andWhere(
        '(thread.subject ILIKE :search OR tenant.name ILIKE :search)',
        { search: `%${filters.search}%` },
      );
    }

    const threads = await query.getMany();

    return threads.map((t) => ({
      id: t.id,
      tenantId: t.tenantId,
      tenantName: t.tenant?.name || 'Unknown',
      subject: t.subject,
      lastMessage: t.lastMessage ?? null,
      lastMessageAt: t.lastMessageAt ?? null,
      unreadCount:
        user.role === Role.SUPER_ADMIN ? t.unreadCountAdmin : t.unreadCountTenant,
      messageCount: t.messageCount,
      status: t.status,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));
  }

  /**
   * Get a single thread by ID
   */
  async getThread(userId: string, threadId: string): Promise<MessageThread> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const thread = await this.threadRepository.findOne({
      where: { id: threadId },
      relations: ['tenant'],
    });

    if (!thread) throw new NotFoundException('Thread not found');

    // TenantAdmin can only access their tenant's threads
    if (user.role === Role.TENANT_ADMIN && thread.tenantId !== user.tenantId) {
      throw new ForbiddenException('Access denied');
    }

    return thread;
  }

  /**
   * Get messages in a thread
   */
  async getMessages(userId: string, threadId: string): Promise<MessageItem[]> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    // Verify access
    await this.getThread(userId, threadId);

    const query = this.messageRepository
      .createQueryBuilder('message')
      .where('message.threadId = :threadId', { threadId })
      .orderBy('message.createdAt', 'ASC');

    // TenantAdmin cannot see internal notes
    if (user.role !== Role.SUPER_ADMIN) {
      query.andWhere('message.isInternal = false');
    }

    const messages = await query.getMany();

    // Mark messages as read
    await this.markMessagesAsRead(userId, threadId, user.role === Role.SUPER_ADMIN);

    return messages.map((m) => ({
      id: m.id,
      threadId: m.threadId,
      senderId: m.senderId,
      senderType: m.senderType,
      senderName: m.senderName,
      content: m.content,
      status: m.status,
      isInternal: m.isInternal,
      attachments: m.attachments ?? null,
      readAt: m.readAt ?? null,
      createdAt: m.createdAt,
    }));
  }

  /**
   * Create a new thread
   */
  async createThread(
    userId: string,
    input: CreateThreadInput,
  ): Promise<MessageThread> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    let tenantId: string;
    let isSuperAdmin = false;

    if (user.role === Role.SUPER_ADMIN) {
      if (!input.tenantId) {
        throw new BadRequestException('Tenant ID required for SuperAdmin');
      }
      tenantId = input.tenantId;
      isSuperAdmin = true;
    } else if (user.role === Role.TENANT_ADMIN) {
      if (!user.tenantId) {
        throw new BadRequestException('User has no tenant');
      }
      tenantId = user.tenantId;
    } else {
      throw new ForbiddenException('Only admins can create threads');
    }

    // Verify tenant exists
    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');

    // Create thread
    const thread = this.threadRepository.create({
      tenantId,
      subject: input.subject,
      lastMessage: input.initialMessage,
      lastMessageAt: new Date(),
      lastMessageBy: userId,
      status: ThreadStatus.OPEN,
      messageCount: 1,
      unreadCountAdmin: isSuperAdmin ? 0 : 1,
      unreadCountTenant: isSuperAdmin ? 1 : 0,
      createdBy: userId,
      createdByAdmin: isSuperAdmin,
    });

    const savedThread = await this.threadRepository.save(thread);

    // Create initial message
    const message = this.messageRepository.create({
      threadId: savedThread.id,
      senderId: userId,
      senderType: isSuperAdmin ? SenderType.SUPER_ADMIN : SenderType.TENANT_ADMIN,
      senderName: user.getDisplayName(),
      content: input.initialMessage,
      status: MessageStatus.SENT,
      isInternal: false,
    });

    await this.messageRepository.save(message);

    this.logger.log(`Thread created: ${savedThread.id} by ${user.email}`);
    return savedThread;
  }

  /**
   * Send a message to a thread
   */
  async sendMessage(userId: string, input: SendMessageInput): Promise<Message> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const thread = await this.getThread(userId, input.threadId);

    if (thread.status === ThreadStatus.CLOSED) {
      throw new BadRequestException('Cannot send message to closed thread');
    }

    // Only SuperAdmin can send internal notes
    if (input.isInternal && user.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Only SuperAdmin can create internal notes');
    }

    const isSuperAdmin = user.role === Role.SUPER_ADMIN;

    // Create message
    const message = this.messageRepository.create({
      threadId: thread.id,
      senderId: userId,
      senderType: isSuperAdmin ? SenderType.SUPER_ADMIN : SenderType.TENANT_ADMIN,
      senderName: user.getDisplayName(),
      content: input.content,
      status: MessageStatus.SENT,
      isInternal: input.isInternal,
    });

    const savedMessage = await this.messageRepository.save(message);

    // SECURITY: Use atomic increment for messageCount to prevent race conditions
    await this.threadRepository.increment(
      { id: thread.id },
      'messageCount',
      1,
    );

    // Update thread metadata
    const updateData: Record<string, unknown> = {
      lastMessageAt: new Date(),
      lastMessageBy: userId,
    };
    if (!input.isInternal) {
      updateData['lastMessage'] = input.content;
    }
    await this.threadRepository.update(thread.id, updateData as Parameters<typeof this.threadRepository.update>[1]);

    if (!input.isInternal) {
      if (isSuperAdmin) {
        await this.threadRepository.increment(
          { id: thread.id },
          'unreadCountTenant',
          1,
        );
      } else {
        await this.threadRepository.increment(
          { id: thread.id },
          'unreadCountAdmin',
          1,
        );
      }
    }

    this.logger.log(`Message sent to thread ${thread.id} by ${user.email}`);
    return savedMessage;
  }

  /**
   * Close a thread
   */
  async closeThread(userId: string, threadId: string): Promise<MessageThread> {
    const thread = await this.getThread(userId, threadId);

    thread.status = ThreadStatus.CLOSED;
    const saved = await this.threadRepository.save(thread);

    this.logger.log(`Thread ${threadId} closed`);
    return saved;
  }

  /**
   * Reopen a thread
   */
  async reopenThread(userId: string, threadId: string): Promise<MessageThread> {
    const thread = await this.getThread(userId, threadId);

    thread.status = ThreadStatus.OPEN;
    const saved = await this.threadRepository.save(thread);

    this.logger.log(`Thread ${threadId} reopened`);
    return saved;
  }

  /**
   * Archive a thread (SuperAdmin only)
   */
  async archiveThread(userId: string, threadId: string): Promise<MessageThread> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (user?.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Only SuperAdmin can archive threads');
    }

    const thread = await this.getThread(userId, threadId);
    thread.status = ThreadStatus.ARCHIVED;
    return this.threadRepository.save(thread);
  }

  // =========================================================
  // Bulk Messaging (SuperAdmin only)
  // =========================================================

  /**
   * Open a support thread with the given subject/message for EVERY active
   * tenant. Mirrors the admin-panel bulk-message action (one thread + initial
   * message per tenant); the SuperAdmin is the sender on each. Returns the
   * per-tenant send/failure tally.
   */
  async sendBulkSupportMessage(
    userId: string,
    input: BulkMessageInput,
  ): Promise<BulkMessageResult> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Only SuperAdmin can send bulk messages');
    }

    const activeTenants = await this.tenantRepository.find({
      where: { status: TenantStatus.ACTIVE },
    });

    const senderName = user.getDisplayName();
    let sent = 0;
    let failed = 0;

    for (const tenant of activeTenants) {
      try {
        const thread = this.threadRepository.create({
          tenantId: tenant.id,
          subject: input.subject,
          lastMessage: input.content,
          lastMessageAt: new Date(),
          lastMessageBy: userId,
          status: ThreadStatus.OPEN,
          messageCount: 1,
          unreadCountAdmin: 0,
          unreadCountTenant: 1,
          createdBy: userId,
          createdByAdmin: true,
        });
        const savedThread = await this.threadRepository.save(thread);

        const message = this.messageRepository.create({
          threadId: savedThread.id,
          senderId: userId,
          senderType: SenderType.SUPER_ADMIN,
          senderName,
          content: input.content,
          status: MessageStatus.SENT,
          isInternal: false,
        });
        await this.messageRepository.save(message);
        sent++;
      } catch (err) {
        const error = err as Error;
        this.logger.error(
          `Bulk support message failed for tenant ${tenant.id}: ${error.message}`,
        );
        failed++;
      }
    }

    this.logger.log(
      `Bulk support message opened ${sent} thread(s) (${failed} failed) by ${user.email}`,
    );
    return { sent, failed };
  }

  /**
   * Mark messages as read
   */
  private async markMessagesAsRead(
    userId: string,
    threadId: string,
    isSuperAdmin: boolean,
  ): Promise<void> {
    // Update message read status
    const targetSenderType = isSuperAdmin
      ? SenderType.TENANT_ADMIN
      : SenderType.SUPER_ADMIN;

    await this.messageRepository
      .createQueryBuilder()
      .update(Message)
      .set({ status: MessageStatus.READ, readAt: new Date() })
      .where('threadId = :threadId', { threadId })
      .andWhere('senderType = :senderType', { senderType: targetSenderType })
      .andWhere('status != :read', { read: MessageStatus.READ })
      .execute();

    // Reset unread count
    if (isSuperAdmin) {
      await this.threadRepository.update(threadId, { unreadCountAdmin: 0 });
    } else {
      await this.threadRepository.update(threadId, { unreadCountTenant: 0 });
    }
  }

  // =========================================================
  // Statistics
  // =========================================================

  /**
   * Get messaging statistics
   */
  async getStats(userId: string): Promise<MessagingStats> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    // PERF: Use SQL aggregation instead of loading all threads into memory (HIGH-09/L-07)
    const isSuperAdmin = user.role === Role.SUPER_ADMIN;
    const unreadColumn = isSuperAdmin ? 'thread.unreadCountAdmin' : 'thread.unreadCountTenant';

    let query = this.threadRepository
      .createQueryBuilder('thread')
      .select('COUNT(*)', 'totalThreads')
      .addSelect(`COUNT(*) FILTER (WHERE thread.status = :open)`, 'activeThreads')
      .addSelect(`COUNT(*) FILTER (WHERE thread.status = :closed)`, 'closedThreads')
      .addSelect('COALESCE(SUM(thread.messageCount), 0)', 'totalMessages')
      .addSelect(`COALESCE(SUM(${unreadColumn}), 0)`, 'unreadMessages')
      .setParameters({
        open: ThreadStatus.OPEN,
        closed: ThreadStatus.CLOSED,
      });

    // TenantAdmin sees only their tenant's stats
    if (user.role === Role.TENANT_ADMIN && user.tenantId) {
      query = query.where('thread.tenantId = :tenantId', {
        tenantId: user.tenantId,
      });
    }

    const result = await query.getRawOne();

    return {
      totalThreads: parseInt(result?.totalThreads ?? '0') || 0,
      activeThreads: parseInt(result?.activeThreads ?? '0') || 0,
      closedThreads: parseInt(result?.closedThreads ?? '0') || 0,
      totalMessages: parseInt(result?.totalMessages ?? '0') || 0,
      unreadMessages: parseInt(result?.unreadMessages ?? '0') || 0,
      avgResponseTimeMinutes: 45, // TODO: Calculate actual average
    };
  }
}
