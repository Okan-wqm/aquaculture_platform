import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';

import { FeatureFlagOverride } from '../entities/debug-session.entity';

/**
 * Feature Flag Debug Service
 * Handles feature flag overrides for debugging
 * SRP: Only responsible for feature flag override operations
 */
@Injectable()
export class FeatureFlagDebugService {
  private readonly logger = new Logger(FeatureFlagDebugService.name);

  constructor(
    @InjectRepository(FeatureFlagOverride)
    private readonly overrideRepo: Repository<FeatureFlagOverride>,
  ) {}

  /**
   * Create a feature flag override
   */
  async createFeatureFlagOverride(data: {
    tenantId: string;
    featureKey: string;
    originalValue: unknown;
    overrideValue: unknown;
    adminId: string;
    reason?: string;
    expiresAt?: Date;
  }): Promise<FeatureFlagOverride> {
    // Check for existing override
    const existing = await this.overrideRepo.findOne({
      where: { tenantId: data.tenantId, featureKey: data.featureKey, isActive: true },
    });

    if (existing) {
      throw new BadRequestException(
        `Override already exists for feature '${data.featureKey}' on tenant '${data.tenantId}'`,
      );
    }

    const override = this.overrideRepo.create({
      ...data,
      isActive: true,
      appliedAt: new Date(),
    });

    const saved = await this.overrideRepo.save(override);

    this.logger.log(
      `Created feature flag override: ${data.featureKey} = ${JSON.stringify(data.overrideValue)} for tenant ${data.tenantId}`,
    );

    return saved;
  }

  /**
   * Revert a feature flag override
   */
  async revertFeatureFlagOverride(overrideId: string, revertedBy: string): Promise<FeatureFlagOverride> {
    const override = await this.overrideRepo.findOne({ where: { id: overrideId } });
    if (!override) {
      throw new NotFoundException(`Override not found: ${overrideId}`);
    }

    override.isActive = false;
    override.revertedAt = new Date();
    override.revertedBy = revertedBy;

    const saved = await this.overrideRepo.save(override);

    this.logger.log(`Reverted feature flag override: ${override.featureKey} for tenant ${override.tenantId}`);

    return saved;
  }

  /**
   * Get active overrides for a tenant
   */
  async getActiveOverridesForTenant(tenantId: string): Promise<FeatureFlagOverride[]> {
    return this.overrideRepo.find({
      where: { tenantId, isActive: true },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get all active overrides (for dashboard)
   */
  async getAllActiveOverrides(tenantId?: string, limit: number = 10): Promise<FeatureFlagOverride[]> {
    return this.overrideRepo.find({
      where: tenantId ? { tenantId, isActive: true } : { isActive: true },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * Get feature override by ID
   */
  async getFeatureOverride(id: string): Promise<FeatureFlagOverride> {
    const override = await this.overrideRepo.findOne({ where: { id } });
    if (!override) {
      throw new NotFoundException(`Feature override not found: ${id}`);
    }
    return override;
  }

  /**
   * Get feature flag value with override check
   */
  async getFeatureFlagValue(tenantId: string, featureKey: string, defaultValue: unknown): Promise<unknown> {
    const override = await this.overrideRepo.findOne({
      where: { tenantId, featureKey, isActive: true },
    });

    if (override) {
      // Check expiration
      if (override.expiresAt && override.expiresAt < new Date()) {
        await this.revertFeatureFlagOverride(override.id, 'system');
        return defaultValue;
      }
      return override.overrideValue;
    }

    return defaultValue;
  }

  /**
   * Query overrides with filters
   */
  async queryOverrides(params: {
    tenantId?: string;
    adminId?: string;
    featureKey?: string;
    isActive?: boolean;
    page?: number;
    limit?: number;
  }): Promise<{ items: FeatureFlagOverride[]; total: number }> {
    const query = this.overrideRepo.createQueryBuilder('o');

    if (params.tenantId) {
      query.andWhere('o.tenantId = :tenantId', { tenantId: params.tenantId });
    }
    if (params.adminId) {
      query.andWhere('o.adminId = :adminId', { adminId: params.adminId });
    }
    if (params.featureKey) {
      query.andWhere('o.featureKey = :featureKey', { featureKey: params.featureKey });
    }
    if (params.isActive !== undefined) {
      query.andWhere('o.isActive = :isActive', { isActive: params.isActive });
    }

    query.orderBy('o.createdAt', 'DESC');

    const page = params.page || 1;
    const limit = params.limit || 20;
    query.skip((page - 1) * limit).take(limit);

    const [items, total] = await query.getManyAndCount();
    return { items, total };
  }

  /**
   * Expire overrides that have passed their expiration time
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async expireOverrides(): Promise<void> {
    const expired = await this.overrideRepo.find({
      where: {
        isActive: true,
        expiresAt: LessThan(new Date()),
      },
    });

    for (const override of expired) {
      override.isActive = false;
      override.revertedAt = new Date();
      override.revertedBy = 'system';
      await this.overrideRepo.save(override);
    }

    if (expired.length > 0) {
      this.logger.log(`Expired ${expired.length} feature flag overrides`);
    }
  }
}
