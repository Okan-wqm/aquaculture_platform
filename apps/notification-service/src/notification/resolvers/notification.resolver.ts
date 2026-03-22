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
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tenant, CurrentUser } from '@aquaculture/backend-common';
import { InAppNotificationService } from '../services/in-app.service';
import { DeviceToken } from '../entities/device-token.entity';

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
      const metadata = log.metadata as Record<string, unknown> | undefined;
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
  ): Promise<boolean> {
    return await this.inAppService.markAsRead(id, user.sub);
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
      // Check if token already exists for this user
      const existing = await this.deviceTokenRepository.findOne({
        where: { userId: user.sub, token },
      });

      if (existing) {
        // Update lastSeenAt
        existing.lastSeenAt = new Date();
        existing.platform = platform;
        existing.tenantId = tenantId;
        await this.deviceTokenRepository.save(existing);
      } else {
        // Create new token record
        const deviceToken = this.deviceTokenRepository.create({
          userId: user.sub,
          tenantId,
          token,
          platform,
          lastSeenAt: new Date(),
        });
        await this.deviceTokenRepository.save(deviceToken);
      }

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
}
