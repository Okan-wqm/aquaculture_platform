import { Logger, NotFoundException } from '@nestjs/common';
import { Resolver, Mutation, Args, Query } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentUser, SkipTenantGuard } from '@aquaculture/backend-common';

import { User } from '../entities/user.entity';
import {
  NotificationPreferences,
  UpdateNotificationPreferencesInput,
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationPreferencesData,
} from '../dto/notification-preferences.dto';

@Resolver(() => NotificationPreferences)
export class NotificationPreferencesResolver {
  private readonly logger = new Logger(NotificationPreferencesResolver.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  /**
   * Get the current user's notification preferences.
   * Returns defaults if the user has not customized their preferences.
   */
  @SkipTenantGuard()
  @Query(() => NotificationPreferences, {
    name: 'getMyNotificationPreferences',
    description: 'Get the current user\'s notification preferences',
  })
  async getMyNotificationPreferences(
    @CurrentUser('sub') userId: string,
  ): Promise<NotificationPreferences> {
    let prefs: NotificationPreferencesData | null = null;

    try {
      const user = await this.userRepository
        .createQueryBuilder('user')
        .select(['user.id'])
        .addSelect('user.notificationPreferences')
        .where('user.id = :userId', { userId })
        .getOne();

      if (!user) {
        throw new NotFoundException('User not found');
      }

      prefs = user.notificationPreferences || null;
    } catch (error) {
      // Column may not exist yet if migration hasn't run
      if (String(error).includes('does not exist')) {
        this.logger.warn('notificationPreferences column not yet created, returning defaults');
      } else if (error instanceof NotFoundException) {
        throw error;
      } else {
        this.logger.error('Failed to fetch notification preferences', error);
      }
    }

    const result = prefs || DEFAULT_NOTIFICATION_PREFERENCES;

    return {
      emailEnabled: result.emailEnabled,
      smsEnabled: result.smsEnabled,
      pushEnabled: result.pushEnabled,
      quietHoursStart: result.quietHoursStart,
      quietHoursEnd: result.quietHoursEnd,
      quietHoursTimezone: result.quietHoursTimezone,
      alertNotifications: result.alertNotifications,
      taskNotifications: result.taskNotifications,
      systemNotifications: result.systemNotifications,
    };
  }

  /**
   * Update the current user's notification preferences.
   * Only provided fields are updated; others retain their current values.
   */
  @SkipTenantGuard()
  @Mutation(() => NotificationPreferences, {
    name: 'updateMyNotificationPreferences',
    description: 'Update the current user\'s notification preferences',
  })
  async updateMyNotificationPreferences(
    @CurrentUser('sub') userId: string,
    @Args('input') input: UpdateNotificationPreferencesInput,
  ): Promise<NotificationPreferences> {
    let currentPrefs: NotificationPreferencesData | null = null;

    try {
      const user = await this.userRepository
        .createQueryBuilder('user')
        .select(['user.id'])
        .addSelect('user.notificationPreferences')
        .where('user.id = :userId', { userId })
        .getOne();

      if (!user) {
        throw new NotFoundException('User not found');
      }

      currentPrefs = user.notificationPreferences || null;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      // Column may not exist yet - proceed with defaults
      this.logger.warn('notificationPreferences column not yet created, using defaults');
      // Verify user exists
      const exists = await this.userRepository.findOne({ where: { id: userId }, select: ['id'] });
      if (!exists) throw new NotFoundException('User not found');
    }

    const current: NotificationPreferencesData =
      currentPrefs || { ...DEFAULT_NOTIFICATION_PREFERENCES };

    const updated: NotificationPreferencesData = {
      emailEnabled: input.emailEnabled !== undefined ? input.emailEnabled : current.emailEnabled,
      smsEnabled: input.smsEnabled !== undefined ? input.smsEnabled : current.smsEnabled,
      pushEnabled: input.pushEnabled !== undefined ? input.pushEnabled : current.pushEnabled,
      quietHoursStart: input.quietHoursStart !== undefined ? input.quietHoursStart : current.quietHoursStart,
      quietHoursEnd: input.quietHoursEnd !== undefined ? input.quietHoursEnd : current.quietHoursEnd,
      quietHoursTimezone: input.quietHoursTimezone !== undefined ? input.quietHoursTimezone : current.quietHoursTimezone,
      alertNotifications: input.alertNotifications !== undefined ? input.alertNotifications : current.alertNotifications,
      taskNotifications: input.taskNotifications !== undefined ? input.taskNotifications : current.taskNotifications,
      systemNotifications: input.systemNotifications !== undefined ? input.systemNotifications : current.systemNotifications,
    };

    try {
      await this.userRepository.update(userId, {
        notificationPreferences: updated,
      });
    } catch (error) {
      if (String(error).includes('does not exist')) {
        this.logger.warn('notificationPreferences column not yet created, cannot save');
        // Still return the computed preferences even if we can't persist
      } else {
        throw error;
      }
    }

    this.logger.log(`Updated notification preferences for user ${userId.substring(0, 8)}...`);

    return {
      emailEnabled: updated.emailEnabled,
      smsEnabled: updated.smsEnabled,
      pushEnabled: updated.pushEnabled,
      quietHoursStart: updated.quietHoursStart,
      quietHoursEnd: updated.quietHoursEnd,
      quietHoursTimezone: updated.quietHoursTimezone,
      alertNotifications: updated.alertNotifications,
      taskNotifications: updated.taskNotifications,
      systemNotifications: updated.systemNotifications,
    };
  }
}
