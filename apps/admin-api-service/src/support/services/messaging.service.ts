/**
 * Messaging Service
 *
 * Super admin - tenant admin mesajlaşma sistemi.
 */

import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull, Not } from 'typeorm';
import {
  MessageThread,
  Message,
  MessageStatus,
  MessageAttachment,
  ThreadSummary,
  BulkMessageRequest,
  AnnouncementTarget,
} from '../entities/support.entity';
import { TenantReadOnly, TenantStatus, TenantPlan } from '../../analytics/entities/external/tenant.entity';

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    @InjectRepository(MessageThread)
    private readonly threadRepository: Repository<MessageThread>,
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(TenantReadOnly)
    private readonly tenantRepository: Repository<TenantReadOnly>,
  ) {}

  // ============================================================================
  // Thread Management
  // ============================================================================

  /**
   * Create new message thread
   */
  async createThread(
    tenantId: string,
    subject: string,
    initialMessage: string,
    senderId: string,
    senderType: 'admin' | 'tenant_admin',
    senderName: string,
  ): Promise<MessageThread> {
    this.logger.log(`Creating thread for tenant ${tenantId}: ${subject}`);

    // Create thread
    const thread = this.threadRepository.create({
      tenantId,
      subject,
      messageCount: 0,
      unreadAdminCount: senderType === 'tenant_admin' ? 1 : 0,
      unreadTenantCount: senderType === 'admin' ? 1 : 0,
    });
    await this.threadRepository.save(thread);

    // Add initial message
    await this.addMessage(thread.id, {
      senderId,
      senderType,
      senderName,
      content: initialMessage,
      isInternal: false,
    });

    return this.getThread(thread.id);
  }

  /**
   * Get thread by ID
   */
  async getThread(threadId: string): Promise<MessageThread> {
    const thread = await this.threadRepository.findOne({
      where: { id: threadId },
      relations: ['messages'],
    });

    if (!thread) {
      throw new NotFoundException(`Thread not found: ${threadId}`);
    }

    return thread;
  }

  /**
   * Get threads for tenant
   */
  async getThreadsForTenant(tenantId: string): Promise<MessageThread[]> {
    return this.threadRepository.find({
      where: { tenantId, isArchived: false },
      order: { lastMessageAt: 'DESC' },
    });
  }

  /**
   * Get all threads with pagination
   */
  async getAllThreads(options: {
    page?: number;
    limit?: number;
    status?: 'open' | 'closed' | 'all';
    hasUnread?: boolean;
  }): Promise<{
    data: ThreadSummary[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { page = 1, limit = 20, status = 'all', hasUnread } = options;

    const where: Record<string, unknown> = {
      isArchived: false,
    };

    if (status === 'open') where.isClosed = false;
    if (status === 'closed') where.isClosed = true;
    if (hasUnread) where.unreadAdminCount = Not(0);

    const [threads, total] = await this.threadRepository.findAndCount({
      where,
      order: { lastMessageAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    // OPTIMIZED: Get last message for all threads in a single query using DISTINCT ON
    const threadIds = threads.map(t => t.id);
    const lastMessagesMap = new Map<string, Message>();

    if (threadIds.length > 0) {
      // PostgreSQL DISTINCT ON to get last message per thread efficiently
      const lastMessages = await this.messageRepository
        .createQueryBuilder('msg')
        .distinctOn(['msg.threadId'])
        .where('msg.threadId IN (:...threadIds)', { threadIds })
        .orderBy('msg.threadId')
        .addOrderBy('msg.createdAt', 'DESC')
        .getMany();

      for (const msg of lastMessages) {
        lastMessagesMap.set(msg.threadId, msg);
      }
    }

    // Map threads to summaries without additional queries
    const data: ThreadSummary[] = threads.map((thread) => {
      const lastMessage = lastMessagesMap.get(thread.id);

      return {
        id: thread.id,
        tenantId: thread.tenantId,
        tenantName: (thread.metadata as Record<string, string>)?.tenantName || 'Unknown',
        subject: thread.subject,
        lastMessage: lastMessage?.content.substring(0, 100) || '',
        lastMessageAt: thread.lastMessageAt,
        unreadCount: thread.unreadAdminCount,
        messageCount: thread.messageCount,
        isClosed: thread.isClosed,
      };
    });

    return { data, total, page, limit };
  }

  /**
   * Close thread
   */
  async closeThread(threadId: string): Promise<MessageThread> {
    const thread = await this.getThread(threadId);
    thread.isClosed = true;
    return this.threadRepository.save(thread);
  }

  /**
   * Reopen thread
   */
  async reopenThread(threadId: string): Promise<MessageThread> {
    const thread = await this.getThread(threadId);
    thread.isClosed = false;
    return this.threadRepository.save(thread);
  }

  /**
   * Archive thread
   */
  async archiveThread(threadId: string): Promise<MessageThread> {
    const thread = await this.getThread(threadId);
    thread.isArchived = true;
    return this.threadRepository.save(thread);
  }

  // ============================================================================
  // Message Management
  // ============================================================================

  /**
   * Add message to thread
   */
  async addMessage(
    threadId: string,
    data: {
      senderId: string;
      senderType: 'admin' | 'tenant_admin' | 'system';
      senderName: string;
      content: string;
      isInternal?: boolean;
      attachments?: MessageAttachment[];
    },
  ): Promise<Message> {
    const thread = await this.threadRepository.findOne({
      where: { id: threadId },
    });

    if (!thread) {
      throw new NotFoundException(`Thread not found: ${threadId}`);
    }

    if (thread.isClosed) {
      throw new BadRequestException('Cannot add message to closed thread');
    }

    // Create message
    const message = this.messageRepository.create({
      threadId,
      senderId: data.senderId,
      senderType: data.senderType,
      senderName: data.senderName,
      content: data.content,
      isInternal: data.isInternal || false,
      attachments: data.attachments || [],
      status: 'sent' as MessageStatus,
    });
    await this.messageRepository.save(message);

    // Update thread
    thread.lastMessageId = message.id;
    thread.lastMessageAt = new Date();
    thread.messageCount += 1;

    // Update unread counts
    if (data.senderType === 'admin' || data.senderType === 'system') {
      if (!data.isInternal) {
        thread.unreadTenantCount += 1;
      }
    } else {
      thread.unreadAdminCount += 1;
    }

    await this.threadRepository.save(thread);

    // TODO: Send email notification if configured
    // await this.sendEmailNotification(message);

    this.logger.log(`Message added to thread ${threadId}`);
    return message;
  }

  /**
   * Get messages for thread
   */
  async getMessages(
    threadId: string,
    options: {
      includeInternal?: boolean;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<Message[]> {
    const { includeInternal = true, page = 1, limit = 50 } = options;

    const where: Record<string, unknown> = { threadId };
    if (!includeInternal) where.isInternal = false;

    return this.messageRepository.find({
      where,
      order: { createdAt: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  /**
   * Mark messages as read
   */
  async markMessagesAsRead(
    threadId: string,
    readerType: 'admin' | 'tenant',
  ): Promise<void> {
    const thread = await this.getThread(threadId);

    // Update message statuses
    const senderTypes = readerType === 'admin'
      ? ['tenant_admin']
      : ['admin', 'system'];

    await this.messageRepository.update(
      {
        threadId,
        senderType: In(senderTypes),
        readAt: IsNull(),
      },
      {
        status: 'read' as MessageStatus,
        readAt: new Date(),
      },
    );

    // Update thread unread count
    if (readerType === 'admin') {
      thread.unreadAdminCount = 0;
    } else {
      thread.unreadTenantCount = 0;
    }
    await this.threadRepository.save(thread);
  }

  // ============================================================================
  // Bulk Messaging
  // ============================================================================

  /**
   * Send bulk message to multiple tenants
   */
  async sendBulkMessage(
    request: BulkMessageRequest,
    senderId: string,
    senderName: string,
    tenantIds: string[],
  ): Promise<{
    sent: number;
    failed: number;
    threadIds: string[];
  }> {
    this.logger.log(`Sending bulk message to ${tenantIds.length} tenants`);

    let sent = 0;
    let failed = 0;
    const threadIds: string[] = [];

    for (const tenantId of tenantIds) {
      try {
        const thread = await this.createThread(
          tenantId,
          request.subject,
          request.content,
          senderId,
          'admin',
          senderName,
        );
        threadIds.push(thread.id);
        sent++;

        // TODO: Send email if request.sendEmail is true
      } catch (err) {
        const error = err as Error;
        this.logger.error(`Failed to send message to tenant ${tenantId}: ${error.message}`);
        failed++;
      }
    }

    return { sent, failed, threadIds };
  }

  /**
   * Get tenants matching target criteria from database
   */
  async getTargetTenants(criteria: AnnouncementTarget): Promise<string[]> {
    // Build query based on criteria
    const queryBuilder = this.tenantRepository
      .createQueryBuilder('tenant')
      .select('tenant.id');

    // Filter by specific tenant IDs if provided
    if (criteria.tenantIds?.length) {
      queryBuilder.andWhere('tenant.id IN (:...tenantIds)', { tenantIds: criteria.tenantIds });
    }

    // Exclude specific tenant IDs
    if (criteria.excludeTenantIds?.length) {
      queryBuilder.andWhere('tenant.id NOT IN (:...excludeIds)', { excludeIds: criteria.excludeTenantIds });
    }

    // Filter by plans
    if (criteria.plans?.length) {
      queryBuilder.andWhere('tenant.plan IN (:...plans)', { plans: criteria.plans });
    }

    // Filter by status (only active tenants by default)
    if (criteria.includeInactive !== true) {
      queryBuilder.andWhere('tenant.status = :status', { status: TenantStatus.ACTIVE });
    }

    // Filter by region if provided
    if (criteria.regions?.length) {
      queryBuilder.andWhere('tenant.region IN (:...regions)', { regions: criteria.regions });
    }

    const tenants = await queryBuilder.getRawMany();
    return tenants.map(t => t.tenant_id);
  }

  // ============================================================================
  // Statistics
  // ============================================================================

  /**
   * Get messaging statistics
   */
  async getMessagingStats(): Promise<{
    totalThreads: number;
    activeThreads: number;
    closedThreads: number;
    totalMessages: number;
    unreadMessages: number;
    avgResponseTimeMinutes: number;
  }> {
    const [threads, totalMessages] = await Promise.all([
      this.threadRepository.find({ where: { isArchived: false } }),
      this.messageRepository.count(),
    ]);

    const activeThreads = threads.filter(t => !t.isClosed).length;
    const closedThreads = threads.filter(t => t.isClosed).length;
    const unreadMessages = threads.reduce((sum, t) => sum + t.unreadAdminCount, 0);

    // Calculate average response time from actual message data
    const avgResponseTimeMinutes = await this.calculateAvgResponseTime();

    return {
      totalThreads: threads.length,
      activeThreads,
      closedThreads,
      totalMessages,
      unreadMessages,
      avgResponseTimeMinutes,
    };
  }

  /**
   * Calculate average response time from message pairs
   */
  private async calculateAvgResponseTime(): Promise<number> {
    // Get messages with their thread info to calculate response times
    const result = await this.messageRepository
      .createQueryBuilder('msg')
      .select('AVG(EXTRACT(EPOCH FROM (msg.createdAt - prev.createdAt)) / 60)', 'avgMinutes')
      .innerJoin(
        Message,
        'prev',
        'prev.threadId = msg.threadId AND prev.createdAt < msg.createdAt AND prev.senderType != msg.senderType'
      )
      .where('msg.senderType = :adminType', { adminType: 'admin' })
      .getRawOne();

    // Return calculated average or default of 0 if no data
    return Math.round(result?.avgMinutes || 0);
  }

  /**
   * Get unread count for admin
   */
  async getUnreadCount(): Promise<number> {
    const result = await this.threadRepository
      .createQueryBuilder('thread')
      .select('SUM(thread.unreadAdminCount)', 'total')
      .where('thread.isArchived = :archived', { archived: false })
      .getRawOne();

    return parseInt(result?.total || '0', 10);
  }
}
