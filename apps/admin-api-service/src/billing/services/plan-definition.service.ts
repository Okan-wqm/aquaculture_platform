import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  PlanDefinition,
  PlanTier,
  PlanVisibility,
  PlanLimits,
  PlanPricing,
  PlanFeatures,
  BillingCycle,
} from '../entities/plan-definition.entity';

export interface CreatePlanDto {
  code: string;
  name: string;
  description?: string;
  shortDescription?: string;
  tier: PlanTier;
  visibility?: PlanVisibility;
  isRecommended?: boolean;
  sortOrder?: number;
  limits: PlanLimits;
  pricing: PlanPricing;
  features: PlanFeatures;
  trialDays?: number;
  gracePeriodDays?: number;
  upgradeMessage?: string;
  downgradeWarning?: string;
  icon?: string;
  color?: string;
  badge?: string;
  createdBy: string;
}

export interface UpdatePlanDto {
  name?: string;
  description?: string;
  shortDescription?: string;
  visibility?: PlanVisibility;
  isActive?: boolean;
  isRecommended?: boolean;
  sortOrder?: number;
  limits?: Partial<PlanLimits>;
  pricing?: Partial<PlanPricing>;
  features?: Partial<PlanFeatures>;
  trialDays?: number;
  gracePeriodDays?: number;
  upgradeMessage?: string;
  downgradeWarning?: string;
  icon?: string;
  color?: string;
  badge?: string;
  updatedBy: string;
}

export interface PlanComparisonResult {
  isUpgrade: boolean;
  isDowngrade: boolean;
  priceDifference: number;
  limitChanges: Array<{
    limit: string;
    currentValue: number;
    newValue: number;
    change: 'increase' | 'decrease' | 'same';
  }>;
  featureChanges: Array<{
    feature: string;
    gaining: boolean;
  }>;
  warnings: string[];
}

export interface ProratedPricing {
  currentPlanCredit: number;
  newPlanCost: number;
  proratedAmount: number;
  daysRemaining: number;
  effectiveDate: Date;
}

/**
 * Plan Definition Service
 * Manages subscription plan configurations
 */
@Injectable()
export class PlanDefinitionService {
  private readonly logger = new Logger(PlanDefinitionService.name);

  constructor(
    @InjectRepository(PlanDefinition)
    private readonly planRepo: Repository<PlanDefinition>,
  ) {}

  /**
   * Get all plan definitions
   */
  async findAll(includeInactive = false): Promise<PlanDefinition[]> {
    const query = this.planRepo.createQueryBuilder('plan');

    if (!includeInactive) {
      query.where('plan.isActive = :isActive', { isActive: true });
    }

    return query
      .orderBy('plan.sortOrder', 'ASC')
      .addOrderBy('plan.tier', 'ASC')
      .getMany();
  }

  /**
   * Get public plans for pricing page
   */
  async findPublicPlans(): Promise<PlanDefinition[]> {
    return this.planRepo.find({
      where: {
        isActive: true,
        visibility: PlanVisibility.PUBLIC,
      },
      order: {
        sortOrder: 'ASC',
      },
    });
  }

  /**
   * Get plan by ID
   */
  async findById(id: string): Promise<PlanDefinition> {
    const plan = await this.planRepo.findOne({ where: { id } });
    if (!plan) {
      throw new NotFoundException(`Plan with ID ${id} not found`);
    }
    return plan;
  }

  /**
   * Get plan by code
   */
  async findByCode(code: string): Promise<PlanDefinition> {
    const plan = await this.planRepo.findOne({ where: { code } });
    if (!plan) {
      throw new NotFoundException(`Plan with code ${code} not found`);
    }
    return plan;
  }

  /**
   * Get plan by tier
   */
  async findByTier(tier: PlanTier): Promise<PlanDefinition | null> {
    return this.planRepo.findOne({
      where: { tier, isActive: true },
      order: { sortOrder: 'ASC' },
    });
  }

  /**
   * Create a new plan definition
   */
  async create(dto: CreatePlanDto): Promise<PlanDefinition> {
    // Check for duplicate code
    const existing = await this.planRepo.findOne({ where: { code: dto.code } });
    if (existing) {
      throw new ConflictException(`Plan with code ${dto.code} already exists`);
    }

    const plan = this.planRepo.create({
      ...dto,
      visibility: dto.visibility || PlanVisibility.PUBLIC,
      isActive: true,
    });

    const saved = await this.planRepo.save(plan);
    this.logger.log(`Created plan definition: ${saved.code} (${saved.name})`);
    return saved;
  }

  /**
   * Update a plan definition
   */
  async update(id: string, dto: UpdatePlanDto): Promise<PlanDefinition> {
    const plan = await this.findById(id);

    // Merge partial updates for nested objects
    if (dto.limits) {
      plan.limits = { ...plan.limits, ...dto.limits };
    }
    if (dto.pricing) {
      plan.pricing = { ...plan.pricing, ...dto.pricing } as PlanPricing;
    }
    if (dto.features) {
      plan.features = { ...plan.features, ...dto.features } as PlanFeatures;
    }

    // Update simple fields
    const simpleFields: (keyof UpdatePlanDto)[] = [
      'name', 'description', 'shortDescription', 'visibility',
      'isActive', 'isRecommended', 'sortOrder', 'trialDays',
      'gracePeriodDays', 'upgradeMessage', 'downgradeWarning',
      'icon', 'color', 'badge', 'updatedBy'
    ];

    for (const field of simpleFields) {
      if (dto[field] !== undefined) {
        (plan as unknown as Record<string, unknown>)[field] = dto[field];
      }
    }

    const saved = await this.planRepo.save(plan);
    this.logger.log(`Updated plan definition: ${saved.code}`);
    return saved;
  }

  /**
   * Soft delete (deprecate) a plan
   */
  async deprecate(id: string, updatedBy: string): Promise<PlanDefinition> {
    const plan = await this.findById(id);
    plan.visibility = PlanVisibility.DEPRECATED;
    plan.isActive = false;
    plan.updatedBy = updatedBy;

    const saved = await this.planRepo.save(plan);
    this.logger.log(`Deprecated plan: ${saved.code}`);
    return saved;
  }

  /**
   * Compare two plans to determine upgrade/downgrade
   */
  async comparePlans(currentPlanId: string, newPlanId: string): Promise<PlanComparisonResult> {
    const [currentPlan, newPlan] = await Promise.all([
      this.findById(currentPlanId),
      this.findById(newPlanId),
    ]);

    const currentPrice = currentPlan.pricing.monthly.basePrice;
    const newPrice = newPlan.pricing.monthly.basePrice;
    const priceDifference = newPrice - currentPrice;

    // Compare limits
    const limitKeys: (keyof PlanLimits)[] = [
      'maxUsers', 'maxFarms', 'maxPonds', 'maxSensors', 'maxModules',
      'storageGB', 'dataRetentionDays', 'apiRateLimit'
    ];

    const limitChanges = limitKeys.map(key => {
      const currentValue = currentPlan.limits[key] as number;
      const newValue = newPlan.limits[key] as number;
      let change: 'increase' | 'decrease' | 'same' = 'same';

      if (newValue > currentValue || (currentValue !== -1 && newValue === -1)) {
        change = 'increase';
      } else if (newValue < currentValue || (currentValue === -1 && newValue !== -1)) {
        change = 'decrease';
      }

      return {
        limit: key,
        currentValue,
        newValue,
        change,
      };
    });

    // Compare boolean features
    const booleanFeatures: (keyof PlanLimits)[] = [
      'alertsEnabled', 'reportsEnabled', 'customBrandingEnabled',
      'apiAccessEnabled', 'customIntegrationsEnabled', 'ssoEnabled',
      'auditLogEnabled', 'prioritySupport', 'dedicatedAccountManager'
    ];

    const featureChanges: Array<{ feature: string; gaining: boolean }> = [];
    for (const feature of booleanFeatures) {
      const currentHas = currentPlan.limits[feature] as boolean;
      const newHas = newPlan.limits[feature] as boolean;
      if (currentHas !== newHas) {
        featureChanges.push({ feature, gaining: newHas });
      }
    }

    // Determine upgrade/downgrade
    const hasAnyDecrease = limitChanges.some(c => c.change === 'decrease') ||
                           featureChanges.some(c => !c.gaining);
    const hasAnyIncrease = limitChanges.some(c => c.change === 'increase') ||
                           featureChanges.some(c => c.gaining);

    const isUpgrade = priceDifference > 0 || (priceDifference === 0 && hasAnyIncrease && !hasAnyDecrease);
    const isDowngrade = priceDifference < 0 || (priceDifference === 0 && hasAnyDecrease && !hasAnyIncrease);

    // Generate warnings
    const warnings: string[] = [];
    if (isDowngrade) {
      warnings.push(newPlan.downgradeWarning || 'Downgrading may result in loss of features or data.');

      const lostFeatures = featureChanges.filter(c => !c.gaining);
      if (lostFeatures.length > 0) {
        warnings.push(`You will lose access to: ${lostFeatures.map(f => f.feature).join(', ')}`);
      }

      const reducedLimits = limitChanges.filter(c => c.change === 'decrease');
      if (reducedLimits.length > 0) {
        for (const limit of reducedLimits) {
          if (limit.limit === 'maxUsers') {
            warnings.push(`User limit will decrease from ${limit.currentValue === -1 ? 'unlimited' : limit.currentValue} to ${limit.newValue}`);
          }
        }
      }
    }

    return {
      isUpgrade,
      isDowngrade,
      priceDifference,
      limitChanges,
      featureChanges,
      warnings,
    };
  }

  /**
   * Calculate prorated pricing for plan change
   */
  calculateProratedPricing(
    currentPlan: PlanDefinition,
    newPlan: PlanDefinition,
    currentPeriodEnd: Date,
    billingCycle: BillingCycle,
  ): ProratedPricing {
    const now = new Date();
    const daysRemaining = Math.max(0, Math.ceil(
      (currentPeriodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    ));

    const cycleDays = this.getBillingCycleDays(billingCycle);
    const dailyRateMultiplier = daysRemaining / cycleDays;

    const currentPrice = this.getPriceForCycle(currentPlan.pricing, billingCycle);
    const newPrice = this.getPriceForCycle(newPlan.pricing, billingCycle);

    // Credit for unused portion of current plan
    const currentPlanCredit = currentPrice * dailyRateMultiplier;

    // Cost for new plan for remaining period
    const newPlanCost = newPrice * dailyRateMultiplier;

    // Prorated amount (positive = customer pays, negative = credit)
    const proratedAmount = newPlanCost - currentPlanCredit;

    return {
      currentPlanCredit: Math.round(currentPlanCredit * 100) / 100,
      newPlanCost: Math.round(newPlanCost * 100) / 100,
      proratedAmount: Math.round(proratedAmount * 100) / 100,
      daysRemaining,
      effectiveDate: now,
    };
  }

  /**
   * Get default plan limits for a tier
   */
  getDefaultLimitsForTier(tier: PlanTier): PlanLimits {
    const defaults: Record<PlanTier, PlanLimits> = {
      [PlanTier.FREE]: {
        maxUsers: 2,
        maxFarms: 1,
        maxPonds: 5,
        maxSensors: 10,
        maxModules: 1,
        storageGB: 1,
        dataRetentionDays: 30,
        apiRateLimit: 100,
        alertsEnabled: true,
        reportsEnabled: false,
        customBrandingEnabled: false,
        apiAccessEnabled: false,
        customIntegrationsEnabled: false,
        ssoEnabled: false,
        auditLogEnabled: false,
        prioritySupport: false,
        dedicatedAccountManager: false,
      },
      [PlanTier.STARTER]: {
        maxUsers: 5,
        maxFarms: 3,
        maxPonds: 20,
        maxSensors: 50,
        maxModules: 3,
        storageGB: 10,
        dataRetentionDays: 90,
        apiRateLimit: 500,
        alertsEnabled: true,
        reportsEnabled: true,
        customBrandingEnabled: false,
        apiAccessEnabled: true,
        customIntegrationsEnabled: false,
        ssoEnabled: false,
        auditLogEnabled: true,
        prioritySupport: false,
        dedicatedAccountManager: false,
      },
      [PlanTier.PROFESSIONAL]: {
        maxUsers: 20,
        maxFarms: 10,
        maxPonds: 100,
        maxSensors: 500,
        maxModules: -1, // unlimited
        storageGB: 100,
        dataRetentionDays: 365,
        apiRateLimit: 2000,
        alertsEnabled: true,
        reportsEnabled: true,
        customBrandingEnabled: true,
        apiAccessEnabled: true,
        customIntegrationsEnabled: true,
        ssoEnabled: false,
        auditLogEnabled: true,
        prioritySupport: true,
        dedicatedAccountManager: false,
      },
      [PlanTier.ENTERPRISE]: {
        maxUsers: -1, // unlimited
        maxFarms: -1,
        maxPonds: -1,
        maxSensors: -1,
        maxModules: -1,
        storageGB: -1, // unlimited
        dataRetentionDays: -1, // unlimited
        apiRateLimit: -1, // unlimited
        alertsEnabled: true,
        reportsEnabled: true,
        customBrandingEnabled: true,
        apiAccessEnabled: true,
        customIntegrationsEnabled: true,
        ssoEnabled: true,
        auditLogEnabled: true,
        prioritySupport: true,
        dedicatedAccountManager: true,
      },
      [PlanTier.CUSTOM]: {
        maxUsers: -1,
        maxFarms: -1,
        maxPonds: -1,
        maxSensors: -1,
        maxModules: -1,
        storageGB: -1,
        dataRetentionDays: -1,
        apiRateLimit: -1,
        alertsEnabled: true,
        reportsEnabled: true,
        customBrandingEnabled: true,
        apiAccessEnabled: true,
        customIntegrationsEnabled: true,
        ssoEnabled: true,
        auditLogEnabled: true,
        prioritySupport: true,
        dedicatedAccountManager: true,
      },
    };

    return defaults[tier];
  }

  /**
   * Seed default plans
   */
  async seedDefaultPlans(createdBy: string): Promise<void> {
    const existingCount = await this.planRepo.count();
    if (existingCount > 0) {
      this.logger.log('Plans already exist, skipping seed');
      return;
    }

    const defaultPlans: CreatePlanDto[] = [
      {
        code: 'free_2024',
        name: 'Free',
        shortDescription: 'Get started with basic features',
        description: 'Perfect for small operations or trying out the platform',
        tier: PlanTier.FREE,
        sortOrder: 0,
        limits: this.getDefaultLimitsForTier(PlanTier.FREE),
        pricing: {
          monthly: { basePrice: 0, perUserPrice: 0, perFarmPrice: 0, perModulePrice: 0 },
          quarterly: { basePrice: 0, perUserPrice: 0, perFarmPrice: 0, perModulePrice: 0, discountPercent: 0 },
          semiAnnual: { basePrice: 0, perUserPrice: 0, perFarmPrice: 0, perModulePrice: 0, discountPercent: 0 },
          annual: { basePrice: 0, perUserPrice: 0, perFarmPrice: 0, perModulePrice: 0, discountPercent: 0 },
          currency: 'USD',
        },
        features: {
          coreFeatures: ['Dashboard', 'Basic alerts', 'Data visualization'],
          advancedFeatures: [],
          premiumFeatures: [],
          addOns: [],
        },
        trialDays: 0,
        gracePeriodDays: 0,
        icon: 'gift',
        color: '#9CA3AF',
        createdBy,
      },
      {
        code: 'starter_2024',
        name: 'Starter',
        shortDescription: 'Essential features for growing farms',
        description: 'Ideal for small to medium aquaculture operations',
        tier: PlanTier.STARTER,
        sortOrder: 1,
        limits: this.getDefaultLimitsForTier(PlanTier.STARTER),
        pricing: {
          monthly: { basePrice: 99, perUserPrice: 10, perFarmPrice: 25, perModulePrice: 15 },
          quarterly: { basePrice: 267, perUserPrice: 27, perFarmPrice: 67, perModulePrice: 40, discountPercent: 10 },
          semiAnnual: { basePrice: 505, perUserPrice: 51, perFarmPrice: 127, perModulePrice: 76, discountPercent: 15 },
          annual: { basePrice: 950, perUserPrice: 96, perFarmPrice: 240, perModulePrice: 144, discountPercent: 20 },
          currency: 'USD',
        },
        features: {
          coreFeatures: ['Dashboard', 'Advanced alerts', 'Data visualization', 'Basic reports', 'Email support'],
          advancedFeatures: ['API access', 'Audit logs'],
          premiumFeatures: [],
          addOns: [
            { code: 'extra_storage', name: 'Extra Storage', description: '10GB additional storage', price: 5, billingCycle: BillingCycle.MONTHLY },
          ],
        },
        trialDays: 14,
        gracePeriodDays: 7,
        icon: 'rocket',
        color: '#3B82F6',
        createdBy,
      },
      {
        code: 'professional_2024',
        name: 'Professional',
        shortDescription: 'Advanced features for serious operations',
        description: 'Best for medium to large aquaculture operations with multiple farms',
        tier: PlanTier.PROFESSIONAL,
        isRecommended: true,
        sortOrder: 2,
        limits: this.getDefaultLimitsForTier(PlanTier.PROFESSIONAL),
        pricing: {
          monthly: { basePrice: 299, perUserPrice: 8, perFarmPrice: 20, perModulePrice: 12 },
          quarterly: { basePrice: 807, perUserPrice: 22, perFarmPrice: 54, perModulePrice: 32, discountPercent: 10 },
          semiAnnual: { basePrice: 1527, perUserPrice: 41, perFarmPrice: 102, perModulePrice: 61, discountPercent: 15 },
          annual: { basePrice: 2870, perUserPrice: 77, perFarmPrice: 192, perModulePrice: 115, discountPercent: 20 },
          currency: 'USD',
        },
        features: {
          coreFeatures: ['Dashboard', 'Advanced alerts', 'Data visualization', 'Custom reports', 'Priority email support'],
          advancedFeatures: ['API access', 'Audit logs', 'Custom branding', 'Integrations', 'Phone support'],
          premiumFeatures: [],
          addOns: [
            { code: 'extra_storage', name: 'Extra Storage', description: '50GB additional storage', price: 20, billingCycle: BillingCycle.MONTHLY },
            { code: 'dedicated_training', name: 'Dedicated Training', description: '2-hour training session', price: 199, billingCycle: BillingCycle.MONTHLY },
          ],
        },
        trialDays: 14,
        gracePeriodDays: 14,
        icon: 'briefcase',
        color: '#8B5CF6',
        badge: 'Most Popular',
        createdBy,
      },
      {
        code: 'enterprise_2024',
        name: 'Enterprise',
        shortDescription: 'Unlimited power for large operations',
        description: 'Enterprise-grade solution for large aquaculture operations',
        tier: PlanTier.ENTERPRISE,
        sortOrder: 3,
        limits: this.getDefaultLimitsForTier(PlanTier.ENTERPRISE),
        pricing: {
          monthly: { basePrice: 999, perUserPrice: 0, perFarmPrice: 0, perModulePrice: 0 },
          quarterly: { basePrice: 2697, perUserPrice: 0, perFarmPrice: 0, perModulePrice: 0, discountPercent: 10 },
          semiAnnual: { basePrice: 5095, perUserPrice: 0, perFarmPrice: 0, perModulePrice: 0, discountPercent: 15 },
          annual: { basePrice: 9590, perUserPrice: 0, perFarmPrice: 0, perModulePrice: 0, discountPercent: 20 },
          currency: 'USD',
        },
        features: {
          coreFeatures: ['Dashboard', 'Advanced alerts', 'Data visualization', 'Custom reports', '24/7 support'],
          advancedFeatures: ['API access', 'Audit logs', 'Custom branding', 'Integrations', 'Dedicated support'],
          premiumFeatures: ['SSO', 'Dedicated account manager', 'Custom SLA', 'On-premise option', 'White-label'],
          addOns: [],
        },
        trialDays: 30,
        gracePeriodDays: 30,
        icon: 'building',
        color: '#F59E0B',
        badge: 'Best Value',
        createdBy,
      },
    ];

    for (const planData of defaultPlans) {
      await this.create(planData);
    }

    this.logger.log(`Seeded ${defaultPlans.length} default plans`);
  }

  private getBillingCycleDays(cycle: BillingCycle): number {
    switch (cycle) {
      case BillingCycle.MONTHLY: return 30;
      case BillingCycle.QUARTERLY: return 90;
      case BillingCycle.SEMI_ANNUAL: return 180;
      case BillingCycle.ANNUAL: return 365;
      default: return 30;
    }
  }

  private getPriceForCycle(pricing: PlanPricing, cycle: BillingCycle): number {
    switch (cycle) {
      case BillingCycle.MONTHLY: return pricing.monthly.basePrice;
      case BillingCycle.QUARTERLY: return pricing.quarterly.basePrice;
      case BillingCycle.SEMI_ANNUAL: return pricing.semiAnnual.basePrice;
      case BillingCycle.ANNUAL: return pricing.annual.basePrice;
      default: return pricing.monthly.basePrice;
    }
  }
}
