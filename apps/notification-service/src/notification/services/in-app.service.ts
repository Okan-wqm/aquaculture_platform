import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import {
  NotificationLog,
  NotificationStatus,
  NotificationChannel,
} from '../entities/notification-log.entity';

/**
 * In-App Notification Service
 * Manages in-app notifications stored in NotificationLog with channel='IN_APP'
 */
@Injectable()
export class InAppNotificationService {
  private readonly logger = new Logger(InAppNotificationService.name);

  constructor(
    @InjectRepository(NotificationLog)
    private readonly logRepository: Repository<NotificationLog>,
  ) {}

  /**
   * Create a new in-app notification
   */
  async createNotification(
    tenantId: string,
    userId: string,
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ): Promise<NotificationLog> {
    const log = this.logRepository.create({
      tenantId,
      channel: NotificationChannel.IN_APP,
      recipient: userId,
      subject: title,
      content: body,
      status: NotificationStatus.SENT,
      sentAt: new Date(),
      metadata: {
        read: false,
        data: data || {},
      },
    });

    const saved = await this.logRepository.save(log);
    this.logger.debug(
      `In-app notification created for user ${userId.substring(0, 8)}... in tenant ${tenantId.substring(0, 8)}...`,
    );
    return saved;
  }

  /**
   * Get notifications for a specific user
   */
  async getMyNotifications(
    userId: string,
    tenantId: string,
    unreadOnly?: boolean,
    limit?: number,
  ): Promise<NotificationLog[]> {
    const queryBuilder = this.logRepository
      .createQueryBuilder('log')
      .where('log.channel = :channel', { channel: NotificationChannel.IN_APP })
      .andWhere('log.recipient = :userId', { userId })
      .andWhere('log.tenant_id = :tenantId', { tenantId })
      .orderBy('log.created_at', 'DESC');

    if (unreadOnly) {
      queryBuilder.andWhere("(log.metadata->>'read' IS NULL OR log.metadata->>'read' = 'false')");
    }

    // SEC-LOW-091 (2026-08-23 scan №36): clamp — .take() accepts any number.
    queryBuilder.take(Math.min(Math.max(limit ?? 50, 1), 500));

    return await queryBuilder.getMany();
  }

  /**
   * Get unread notification count for a user
   */
  async getUnreadCount(userId: string, tenantId: string): Promise<number> {
    return await this.logRepository
      .createQueryBuilder('log')
      .where('log.channel = :channel', { channel: NotificationChannel.IN_APP })
      .andWhere('log.recipient = :userId', { userId })
      .andWhere('log.tenant_id = :tenantId', { tenantId })
      .andWhere("(log.metadata->>'read' IS NULL OR log.metadata->>'read' = 'false')")
      .getCount();
  }

  /**
   * Mark a single notification as read
   * @param id - Notification ID
   * @param userId - Recipient user ID
   * @param tenantId - Tenant UUID for cross-tenant isolation
   */
  async markAsRead(id: string, userId: string, tenantId: string): Promise<boolean> {
    const notification = await this.logRepository.findOne({
      where: {
        id,
        recipient: userId,
        tenantId,
        channel: NotificationChannel.IN_APP,
      },
    });

    if (!notification) {
      this.logger.warn(`Notification ${id} not found for user ${userId.substring(0, 8)}...`);
      return false;
    }

    notification.metadata = {
      ...notification.metadata,
      read: true,
      readAt: new Date().toISOString(),
    };

    await this.logRepository.save(notification);
    return true;
  }

  /**
   * Mark all notifications as read for a user in a tenant
   */
  async markAllAsRead(userId: string, tenantId: string): Promise<boolean> {
    await this.logRepository
      .createQueryBuilder()
      .update(NotificationLog)
      .set({
        metadata: () =>
          `jsonb_set(COALESCE(metadata, '{}'), '{read}', 'true') || jsonb_build_object('readAt', to_jsonb(now()::text))`,
      })
      .where('channel = :channel', { channel: NotificationChannel.IN_APP })
      .andWhere('recipient = :userId', { userId })
      .andWhere('tenant_id = :tenantId', { tenantId })
      .andWhere("(metadata->>'read' IS NULL OR metadata->>'read' = 'false')")
      .execute();

    this.logger.debug(
      `Marked all notifications as read for user ${userId.substring(0, 8)}... in tenant ${tenantId.substring(0, 8)}...`,
    );
    return true;
  }
}
