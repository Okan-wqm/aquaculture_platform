import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MobileUserSettings, DEFAULT_MOBILE_FEATURES } from '../entities/mobile-user-settings.entity';

@Injectable()
export class MobileSettingsService {
  private readonly logger = new Logger(MobileSettingsService.name);

  constructor(
    @InjectRepository(MobileUserSettings)
    private readonly repo: Repository<MobileUserSettings>,
  ) {}

  /**
   * Get mobile settings for a specific user
   * Creates default settings if none exist
   */
  async getByUserId(userId: string, tenantId: string): Promise<MobileUserSettings> {
    let settings = await this.repo.findOne({ where: { userId } });

    if (!settings) {
      settings = this.repo.create({
        userId,
        tenantId,
        allowedFeatures: { ...DEFAULT_MOBILE_FEATURES },
        isMobileEnabled: true,
      });
      settings = await this.repo.save(settings);
      this.logger.debug(`Created default mobile settings for user ${userId}`);
    }

    return settings;
  }

  /**
   * Get mobile settings for all users in a tenant
   */
  async getAllByTenantId(tenantId: string): Promise<MobileUserSettings[]> {
    return this.repo.find({ where: { tenantId } });
  }

  /**
   * Update mobile settings for a user
   */
  async update(
    userId: string,
    tenantId: string,
    data: {
      isMobileEnabled?: boolean;
      allowedFeatures?: Partial<MobileUserSettings['allowedFeatures']>;
    },
  ): Promise<MobileUserSettings> {
    let settings = await this.repo.findOne({ where: { userId } });

    if (!settings) {
      // Create with defaults then apply updates
      settings = this.repo.create({
        userId,
        tenantId,
        allowedFeatures: { ...DEFAULT_MOBILE_FEATURES },
        isMobileEnabled: true,
      });
    }

    if (data.isMobileEnabled !== undefined) {
      settings.isMobileEnabled = data.isMobileEnabled;
    }

    if (data.allowedFeatures) {
      settings.allowedFeatures = {
        ...settings.allowedFeatures,
        ...data.allowedFeatures,
      };
    }

    return this.repo.save(settings);
  }

  /**
   * Bulk update mobile settings for multiple users
   */
  async bulkUpdate(
    tenantId: string,
    userIds: string[],
    data: {
      isMobileEnabled?: boolean;
      allowedFeatures?: Partial<MobileUserSettings['allowedFeatures']>;
    },
  ): Promise<MobileUserSettings[]> {
    const results: MobileUserSettings[] = [];

    for (const userId of userIds) {
      const updated = await this.update(userId, tenantId, data);
      results.push(updated);
    }

    return results;
  }
}
