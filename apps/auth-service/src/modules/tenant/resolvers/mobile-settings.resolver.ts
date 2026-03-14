import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { CurrentUser } from '@platform/backend-common';
import { MobileUserSettings } from '../entities/mobile-user-settings.entity';
import { MobileSettingsService } from '../services/mobile-settings.service';
import { UpdateMobileUserSettingsInput, BulkUpdateMobileSettingsInput } from '../dto/mobile-settings.dto';

@Resolver(() => MobileUserSettings)
export class MobileSettingsResolver {
  constructor(private readonly mobileSettingsService: MobileSettingsService) {}

  /**
   * Get mobile settings for a specific user (admin use)
   */
  @Query(() => MobileUserSettings, { name: 'getMobileUserSettings' })
  async getMobileUserSettings(
    @Args('userId', { type: () => ID }) userId: string,
    @CurrentUser() currentUser: { tenantId: string },
  ): Promise<MobileUserSettings> {
    return this.mobileSettingsService.getByUserId(userId, currentUser.tenantId);
  }

  /**
   * Get current user's own mobile settings (mobile app use)
   */
  @Query(() => MobileUserSettings, { name: 'getMyMobileSettings' })
  async getMyMobileSettings(
    @CurrentUser() currentUser: { id: string; tenantId: string },
  ): Promise<MobileUserSettings> {
    return this.mobileSettingsService.getByUserId(currentUser.id, currentUser.tenantId);
  }

  /**
   * Get all mobile settings for the tenant (admin settings page)
   */
  @Query(() => [MobileUserSettings], { name: 'getMobileUsersSettings' })
  async getMobileUsersSettings(
    @CurrentUser() currentUser: { tenantId: string },
  ): Promise<MobileUserSettings[]> {
    return this.mobileSettingsService.getAllByTenantId(currentUser.tenantId);
  }

  /**
   * Update mobile settings for a specific user
   */
  @Mutation(() => MobileUserSettings, { name: 'updateMobileUserSettings' })
  async updateMobileUserSettings(
    @Args('input') input: UpdateMobileUserSettingsInput,
    @CurrentUser() currentUser: { tenantId: string },
  ): Promise<MobileUserSettings> {
    const { userId, isMobileEnabled, ...featureFlags } = input;

    const allowedFeatures: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(featureFlags)) {
      if (value !== undefined && value !== null) {
        allowedFeatures[key] = value;
      }
    }

    return this.mobileSettingsService.update(userId, currentUser.tenantId, {
      isMobileEnabled,
      allowedFeatures: Object.keys(allowedFeatures).length > 0 ? allowedFeatures : undefined,
    });
  }

  /**
   * Bulk update mobile settings for multiple users
   */
  @Mutation(() => [MobileUserSettings], { name: 'bulkUpdateMobileSettings' })
  async bulkUpdateMobileSettings(
    @Args('input') input: BulkUpdateMobileSettingsInput,
    @CurrentUser() currentUser: { tenantId: string },
  ): Promise<MobileUserSettings[]> {
    const { userIds, isMobileEnabled, ...featureFlags } = input;

    const allowedFeatures: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(featureFlags)) {
      if (value !== undefined && value !== null) {
        allowedFeatures[key] = value;
      }
    }

    return this.mobileSettingsService.bulkUpdate(currentUser.tenantId, userIds, {
      isMobileEnabled,
      allowedFeatures: Object.keys(allowedFeatures).length > 0 ? allowedFeatures : undefined,
    });
  }
}
