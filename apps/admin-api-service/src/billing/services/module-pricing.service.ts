import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, MoreThanOrEqual, IsNull, Or } from 'typeorm';
import {
  ModulePricing,
  PricingMetric,
  TierMultipliers,
} from '../entities/module-pricing.entity';
import { PlanTier } from '../entities/plan-definition.entity';
import { PricingMetricType } from '../entities/pricing-metric.enum';
import {
  DEFAULT_MODULE_PRICING,
  DefaultModulePricingData,
} from '../data/default-module-pricing';

/**
 * DTO for creating/updating module pricing
 */
export interface SetModulePricingDto {
  moduleId: string;
  moduleCode: string;
  pricingMetrics: PricingMetric[];
  tierMultipliers?: TierMultipliers;
  currency?: string;
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
  notes?: string;
}

/**
 * Module pricing with module info
 */
export interface ModulePricingWithModule extends ModulePricing {
  moduleName?: string;
  moduleDescription?: string;
  moduleIcon?: string;
  isModuleActive?: boolean;
}

/**
 * Module Pricing Service
 *
 * Manages pricing configuration for system modules.
 * Handles versioned pricing with effective dates.
 */
@Injectable()
export class ModulePricingService {
  private readonly logger = new Logger(ModulePricingService.name);

  constructor(
    @InjectRepository(ModulePricing)
    private readonly pricingRepo: Repository<ModulePricing>,
  ) {}

  /**
   * Get current active pricing for a module
   */
  async getModulePricing(moduleId: string): Promise<ModulePricing | null> {
    const now = new Date();

    return this.pricingRepo.findOne({
      where: {
        moduleId,
        isActive: true,
        effectiveFrom: LessThanOrEqual(now),
        effectiveTo: Or(IsNull(), MoreThanOrEqual(now)),
      },
      order: { effectiveFrom: 'DESC' },
    });
  }

  /**
   * Get pricing by module code
   */
  async getModulePricingByCode(moduleCode: string): Promise<ModulePricing | null> {
    const now = new Date();

    return this.pricingRepo.findOne({
      where: {
        moduleCode,
        isActive: true,
        effectiveFrom: LessThanOrEqual(now),
        effectiveTo: Or(IsNull(), MoreThanOrEqual(now)),
      },
      order: { effectiveFrom: 'DESC' },
    });
  }

  /**
   * Get all active module pricings
   */
  async getAllModulePricings(): Promise<ModulePricing[]> {
    const now = new Date();

    // Get distinct module codes with their latest pricing
    const pricings = await this.pricingRepo
      .createQueryBuilder('mp')
      .where('mp."isActive" = :isActive', { isActive: true })
      .andWhere('mp."effectiveFrom" <= :now', { now })
      .andWhere('(mp."effectiveTo" IS NULL OR mp."effectiveTo" >= :now)', { now })
      .orderBy('mp."moduleCode"', 'ASC')
      .addOrderBy('mp."effectiveFrom"', 'DESC')
      .getMany();

    // Deduplicate by module code (keep latest)
    const uniquePricings = new Map<string, ModulePricing>();
    for (const pricing of pricings) {
      if (!uniquePricings.has(pricing.moduleCode)) {
        uniquePricings.set(pricing.moduleCode, pricing);
      }
    }

    return Array.from(uniquePricings.values());
  }

  /**
   * Get all module pricings with joined module info
   */
  async getAllModulePricingsWithModuleInfo(): Promise<ModulePricingWithModule[]> {
    const now = new Date();

    // Get pricings with proper entity mapping
    const pricings = await this.pricingRepo.find({
      where: {
        isActive: true,
        effectiveFrom: LessThanOrEqual(now),
      },
      order: { moduleCode: 'ASC' },
    });

    // Filter by effectiveTo
    const activePricings = pricings.filter(
      (p) => !p.effectiveTo || p.effectiveTo >= now,
    );

    // Get module info separately
    const moduleIds = [...new Set(activePricings.map((p) => p.moduleId))];

    // Query modules from public.modules table
    const modules: Array<{ id: string; name: string; description: string; icon: string; isActive: boolean }> =
      await this.pricingRepo.manager.query(
        `SELECT id, name, description, icon, "isActive" FROM public.modules WHERE id = ANY($1)`,
        [moduleIds],
      );

    const moduleMap = new Map(modules.map((m) => [m.id, m]));

    // Combine pricing with module info - return as plain objects
    return activePricings.map((pricing) => {
      const module = moduleMap.get(pricing.moduleId);
      return {
        id: pricing.id,
        moduleId: pricing.moduleId,
        moduleCode: pricing.moduleCode,
        pricingMetrics: pricing.pricingMetrics,
        tierMultipliers: pricing.tierMultipliers,
        currency: pricing.currency,
        effectiveFrom: pricing.effectiveFrom,
        effectiveTo: pricing.effectiveTo,
        isActive: pricing.isActive,
        notes: pricing.notes,
        version: pricing.version,
        createdAt: pricing.createdAt,
        updatedAt: pricing.updatedAt,
        createdBy: pricing.createdBy,
        updatedBy: pricing.updatedBy,
        moduleName: module?.name || pricing.moduleCode,
        moduleDescription: module?.description || '',
        moduleIcon: module?.icon || '',
        isModuleActive: module?.isActive ?? true,
      } as ModulePricingWithModule;
    });
  }

  /**
   * Create or update module pricing
   */
  async setModulePricing(dto: SetModulePricingDto): Promise<ModulePricing> {
    const effectiveFrom = dto.effectiveFrom || new Date();

    // Deactivate any overlapping pricing
    await this.pricingRepo.update(
      {
        moduleId: dto.moduleId,
        isActive: true,
        effectiveTo: Or(IsNull(), MoreThanOrEqual(effectiveFrom)),
      },
      {
        effectiveTo: new Date(effectiveFrom.getTime() - 1000), // End 1 second before
        isActive: false,
      },
    );

    // Create new pricing
    const pricing = this.pricingRepo.create({
      moduleId: dto.moduleId,
      moduleCode: dto.moduleCode,
      pricingMetrics: dto.pricingMetrics,
      tierMultipliers: dto.tierMultipliers || {},
      currency: dto.currency || 'USD',
      effectiveFrom,
      effectiveTo: dto.effectiveTo || null,
      notes: dto.notes,
      isActive: true,
      version: 1,
    });

    const saved = await this.pricingRepo.save(pricing);
    this.logger.log(`Created pricing for module ${dto.moduleCode}, effective from ${effectiveFrom}`);

    return saved;
  }

  /**
   * Update existing pricing (creates new version)
   */
  async updateModulePricing(
    pricingId: string,
    updates: Partial<SetModulePricingDto>,
  ): Promise<ModulePricing> {
    const existing = await this.pricingRepo.findOne({
      where: { id: pricingId },
    });

    if (!existing) {
      throw new NotFoundException(`Pricing not found: ${pricingId}`);
    }

    // Create new version
    const newPricing = await this.setModulePricing({
      moduleId: existing.moduleId,
      moduleCode: existing.moduleCode,
      pricingMetrics: updates.pricingMetrics || existing.pricingMetrics,
      tierMultipliers: updates.tierMultipliers || existing.tierMultipliers,
      currency: updates.currency || existing.currency,
      effectiveFrom: updates.effectiveFrom || new Date(),
      effectiveTo: updates.effectiveTo,
      notes: updates.notes,
    });

    // Increment version
    newPricing.version = existing.version + 1;
    await this.pricingRepo.save(newPricing);

    return newPricing;
  }

  /**
   * Get pricing history for a module
   */
  async getPricingHistory(moduleId: string): Promise<ModulePricing[]> {
    return this.pricingRepo.find({
      where: { moduleId },
      order: { effectiveFrom: 'DESC' },
    });
  }

  /**
   * Deactivate pricing
   */
  async deactivatePricing(pricingId: string): Promise<void> {
    await this.pricingRepo.update(pricingId, {
      isActive: false,
      effectiveTo: new Date(),
    });
  }

  /**
   * Seed default module pricing
   */
  async seedDefaultPricing(moduleIdMap: Map<string, string>): Promise<number> {
    let seeded = 0;

    for (const defaultPricing of DEFAULT_MODULE_PRICING) {
      const moduleId = moduleIdMap.get(defaultPricing.moduleCode);

      if (!moduleId) {
        this.logger.warn(`Module not found for code: ${defaultPricing.moduleCode}`);
        continue;
      }

      // Check if pricing already exists
      const existing = await this.getModulePricingByCode(defaultPricing.moduleCode);
      if (existing) {
        this.logger.debug(`Pricing already exists for ${defaultPricing.moduleCode}`);
        continue;
      }

      await this.setModulePricing({
        moduleId,
        moduleCode: defaultPricing.moduleCode,
        pricingMetrics: defaultPricing.metrics,
        tierMultipliers: defaultPricing.tierMultipliers,
        currency: 'USD',
        notes: 'Default pricing from system seed',
      });

      seeded++;
    }

    this.logger.log(`Seeded ${seeded} module pricings`);
    return seeded;
  }

  /**
   * Get price for a specific metric
   */
  getMetricPrice(pricing: ModulePricing, metricType: PricingMetricType): number {
    return pricing.getMetricPrice(metricType);
  }

  /**
   * Calculate price for a metric with quantity and tier
   */
  calculateMetricCost(
    pricing: ModulePricing,
    metricType: PricingMetricType,
    quantity: number,
    tier: PlanTier = PlanTier.STARTER,
  ): number {
    return pricing.calculateMetricCost(metricType, quantity, tier);
  }

  /**
   * Get included quantity for a metric
   */
  getIncludedQuantity(
    pricing: ModulePricing,
    metricType: PricingMetricType,
  ): number {
    const metric = pricing.pricingMetrics.find((m) => m.type === metricType);
    return metric?.includedQuantity ?? 0;
  }
}
