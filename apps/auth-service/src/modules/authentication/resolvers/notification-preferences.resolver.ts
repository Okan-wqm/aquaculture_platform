import { Logger, NotFoundException } from '@nestjs/common';
import { Resolver, Mutation, Args, Query } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentUser, SkipTenantGuard } from '@platform/backend-common';

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
    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: ['id', 'notificationPreferences'],
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const prefs = user.notificationPreferences || DEFAULT_NOTIFICATION_PREFERENCES;

    return {
      emailEnabled: prefs.emailEnabled,
      smsEnabled: prefs.smsEnabled,
      pushEnabled: prefs.pushEnabled,
      quietHoursStart: prefs.quietHoursStart,
      quietHoursEnd: prefs.quietHoursEnd,
      quietHoursTimezone: prefs.quietHoursTimezone,
      alertNotifications: prefs.alertNotifications,
      taskNotifications: prefs.taskNotifications,
      systemNotifications: prefs.systemNotifications,
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
    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: ['id', 'notificationPreferences'],
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Merge with existing or default preferences
    const current: NotificationPreferencesData =
      user.notificationPreferences || { ...DEFAULT_NOTIFICATION_PREFERENCES };

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

    await this.userRepository.update(userId, {
      notificationPreferences: updated,
    });

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
