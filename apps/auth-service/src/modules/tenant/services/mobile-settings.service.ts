import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
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
  async getByUserId(userId: string, tenantId: string, manager: EntityManager = this.repo.manager): Promise<MobileUserSettings> {
    const repository = manager.withRepository(this.repo);
    // SECURITY: Filter by both userId AND tenantId to enforce tenant isolation
    let settings = await repository.findOne({ where: { userId, tenantId } });

    if (!settings) {
      settings = repository.create({
        userId,
        tenantId,
        allowedFeatures: { ...DEFAULT_MOBILE_FEATURES },
        isMobileEnabled: true,
      });
      settings = await repository.save(settings);
      this.logger.debug(`Created default mobile settings for user ${userId}`);
    } else {
      // Forward-compatibility: merge new feature flags into existing JSONB.
      // When new features are added to DEFAULT_MOBILE_FEATURES, existing user
      // records in the DB won't have them. Spreading defaults underneath ensures
      // new features default to their configured value rather than being silently
      // absent (undefined). Existing explicit user preferences are preserved.
      const merged = {
        ...DEFAULT_MOBILE_FEATURES,
        ...settings.allowedFeatures,
      };

      // One-time migration: waterQuality was seeded as false for all existing users
      // before the feature was implemented. Now that it's a core operational feature
      // (not an optional add-on), auto-enable it. This is safe because no admin ever
      // intentionally disabled waterQuality — the false value comes from the original
      // DEFAULT_MOBILE_FEATURES seed. TODO: Remove this block after 2026-06-01.
      if (settings.allowedFeatures.waterQuality === false) {
        merged.waterQuality = true;
      }

      settings.allowedFeatures = merged;
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
    // SECURITY: Filter by both userId AND tenantId to enforce tenant isolation
    let settings = await this.repo.findOne({ where: { userId, tenantId } });

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
