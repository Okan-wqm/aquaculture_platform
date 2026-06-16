import { Tenant, CurrentUser, Roles, Role } from '@aquaculture/backend-common/decorators';
import { Logger } from '@nestjs/common';
import {
  Resolver,
  Query,
  Mutation,
  Args,
  Int,
  ID,
  ObjectType,
  Field,
} from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { DeviceToken } from '../entities/device-token.entity';
import { DeadLetterQueueService } from '../services/dead-letter-queue.service';
import { InAppNotificationService } from '../services/in-app.service';

/**
 * User context interface
 */
interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
}

/**
 * In-App Notification GraphQL type
 */
@ObjectType()
class InAppNotification {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field()
  body!: string;

  @Field()
  isRead!: boolean;

  @Field({ nullable: true })
  readAt?: string;

  @Field({ nullable: true })
  data?: string; // JSON string of metadata.data

  @Field()
  createdAt!: Date;
}

/**
 * Notification Resolver
 * GraphQL resolver for in-app notification queries and mutations
 */
@Resolver()
export class NotificationResolver {
  private readonly logger = new Logger(NotificationResolver.name);

  constructor(
    private readonly inAppService: InAppNotificationService,
    private readonly dlqService: DeadLetterQueueService,
    @InjectRepository(DeviceToken)
    private readonly deviceTokenRepository: Repository<DeviceToken>,
  ) {}

  /**
   * Get current user's in-app notifications
   */
  @Query(() => [InAppNotification], { name: 'myNotifications' })
  async myNotifications(
    @CurrentUser() user: UserContext,
    @Tenant() tenantId: string,
    @Args('unreadOnly', { type: () => Boolean, nullable: true }) unreadOnly?: boolean,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<InAppNotification[]> {
    const notifications = await this.inAppService.getMyNotifications(
      user.sub,
      tenantId,
      unreadOnly ?? false,
      limit,
    );

    return notifications.map((log) => {
      const metadata = log.metadata;
      const dataObj = metadata?.['data'] as Record<string, unknown> | undefined;

      return {
        id: log.id,
        title: log.subject,
        body: log.content,
        isRead: metadata?.['read'] === true,
        readAt: metadata?.['readAt'] as string | undefined,
        data: dataObj ? JSON.stringify(dataObj) : undefined,
        createdAt: log.createdAt,
      };
    });
  }

  /**
   * Get unread notification count
   */
  @Query(() => Int, { name: 'unreadNotificationCount' })
  async unreadNotificationCount(
    @CurrentUser() user: UserContext,
    @Tenant() tenantId: string,
  ): Promise<number> {
    return await this.inAppService.getUnreadCount(user.sub, tenantId);
  }

  /**
   * Mark a single notification as read
   */
  @Mutation(() => Boolean, { name: 'markNotificationAsRead' })
  async markNotificationAsRead(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() user: UserContext,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    return await this.inAppService.markAsRead(id, user.sub, tenantId);
  }

  /**
   * Mark all notifications as read
   */
  @Mutation(() => Boolean, { name: 'markAllNotificationsAsRead' })
  async markAllNotificationsAsRead(
    @CurrentUser() user: UserContext,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    return await this.inAppService.markAllAsRead(user.sub, tenantId);
  }

  // ── DLQ Management (SUPER_ADMIN only) ─────────────────────────────

  /**
   * Query dead-lettered events for a tenant.
   *
   * SECURITY: Restricted to SUPER_ADMIN to prevent unauthorized replay
   * or inspection of failed events which may contain sensitive payloads.
   * @see PLAT-MEDIUM-004 (DLQ has no RBAC)
   */
  @Query(() => Int, { name: 'deadLetterCount' })
  @Roles(Role.SUPER_ADMIN)
  async deadLetterCount(
    @Tenant() tenantId: string,
  ): Promise<number> {
    const result = await this.dlqService.getDeadLetterEvents(tenantId, 0, 0);
    return result.total;
  }

  /**
   * Register a device token for push notifications
   */
  @Mutation(() => Boolean, { name: 'registerDeviceToken' })
  async registerDeviceToken(
    @Args('token', { type: () => String }) token: string,
    @Args('platform', { type: () => String }) platform: string,
    @CurrentUser() user: UserContext,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    // Validate platform
    const validPlatforms = ['web', 'android', 'ios'];
    if (!validPlatforms.includes(platform)) {
      this.logger.warn(
        `Invalid platform "${platform}" for device token registration`,
      );
      return false;
    }

    try {
      await this.deviceTokenRepository.manager.transaction(async (manager) => {
        const existingForToken = await manager.find(DeviceToken, {
          where: { token },
          lock: { mode: 'pessimistic_write' },
        });
        const currentOwner = existingForToken.find(
          (row) => row.userId === user.sub && row.tenantId === tenantId,
        );
        const previousOwners = existingForToken.filter((row) => row !== currentOwner);

        if (previousOwners.length > 0) {
          await manager.remove(DeviceToken, previousOwners);
        }

        if (currentOwner) {
          currentOwner.lastSeenAt = new Date();
          currentOwner.platform = platform;
          await manager.save(DeviceToken, currentOwner);
          return;
        }

        const deviceToken = manager.create(DeviceToken, {
          userId: user.sub,
          tenantId,
          token,
          platform,
          lastSeenAt: new Date(),
        });
        await manager.save(DeviceToken, deviceToken);
      });

      this.logger.debug(
        `Device token registered for user ${user.sub.substring(0, 8)}... on platform ${platform}`,
      );
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to register device token: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Deregister a device token on logout (MT-HIGH-050).
   *
   * SECURITY: AquaMobil runs on SHARED field devices. Without deregistration the
   * FCM token stays mapped to tenant-A/user-A after logout, so push for tenant-A
   * keeps reaching a phone that is now logged into tenant-B — a cross-tenant push
   * leak. The delete is scoped to the CURRENT (token, userId, tenantId) tuple
   * resolved from the verified JWT, so a caller can only remove the mapping it
   * owns; it can never deregister another user's or tenant's token. Idempotent:
   * removing an already-absent mapping still returns true (logout must not fail
   * because the token was never registered or was already cleared).
   */
  @Mutation(() => Boolean, { name: 'unregisterDeviceToken' })
  async unregisterDeviceToken(
    @Args('token', { type: () => String }) token: string,
    @CurrentUser() user: UserContext,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    try {
      await this.deviceTokenRepository.delete({
        token,
        userId: user.sub,
        tenantId,
      });

      this.logger.debug(
        `Device token deregistered for user ${user.sub.substring(0, 8)}... (logout)`,
      );
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to deregister device token: ${(error as Error).message}`,
      );
      return false;
    }
  }
}
