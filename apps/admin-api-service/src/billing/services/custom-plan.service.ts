import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CustomPlan,
  CustomPlanStatus,
  CustomPlanModule,
  CustomPlanLineItem,
} from '../entities/custom-plan.entity';
import { PlanTier, BillingCycle } from '../entities/plan-definition.entity';
import { PricingCalculatorService } from './pricing-calculator.service';
import {
  SubscriptionManagementService,
  ModuleQuantities,
  SubscriptionModuleConfig,
} from './subscription-management.service';
import { ModulePricingService } from './module-pricing.service';
import { PricingMetricType, PricingMetricLabels } from '../entities/pricing-metric.enum';

/**
 * DTO for creating a custom plan
 */
export interface CreateCustomPlanDto {
  tenantId: string;
  name: string;
  description?: string;
  basePlanId?: string;
  tier?: PlanTier;
  billingCycle?: BillingCycle;
  modules: Array<{
    moduleId: string;
    moduleCode: string;
    moduleName: string;
    quantities: ModuleQuantities;
  }>;
  discountPercent?: number;
  discountAmount?: number;
  discountReason?: string;
  validFrom: Date;
  validTo?: Date;
  notes?: string;
  createdBy?: string;
}

/**
 * DTO for updating custom plan
 */
export interface UpdateCustomPlanDto {
  name?: string;
  description?: string;
  modules?: Array<{
    moduleId: string;
    moduleCode: string;
    moduleName: string;
    quantities: ModuleQuantities;
  }>;
  discountPercent?: number;
  discountAmount?: number;
  discountReason?: string;
  validFrom?: Date;
  validTo?: Date;
  notes?: string;
  updatedBy?: string;
}

/**
 * Filter for listing custom plans
 */
export interface CustomPlanFilter {
  tenantId?: string;
  status?: CustomPlanStatus;
  tier?: PlanTier;
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * Paginated result
 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Custom Plan Service
 *
 * Manages tenant-specific custom plans with:
 * - Module selection and pricing
 * - Approval workflow
 * - Activation to subscription
 */
@Injectable()
export class CustomPlanService {
  private readonly logger = new Logger(CustomPlanService.name);

  constructor(
    @InjectRepository(CustomPlan)
    private readonly planRepo: Repository<CustomPlan>,
    private readonly pricingCalculator: PricingCalculatorService,
    private readonly modulePricingService: ModulePricingService,
    @Inject(forwardRef(() => SubscriptionManagementService))
    private readonly subscriptionService: SubscriptionManagementService,
  ) {}

  /**
   * Create a new custom plan
   */
  async createCustomPlan(dto: CreateCustomPlanDto): Promise<CustomPlan> {
    // Calculate pricing for modules
    const { modules, monthlySubtotal, monthlyTotal } = await this.calculatePlanPricing(
      dto.modules,
      dto.tier || PlanTier.CUSTOM,
      dto.discountPercent,
      dto.discountAmount,
    );

    const plan = this.planRepo.create({
      tenantId: dto.tenantId,
      name: dto.name,
      description: dto.description,
      basePlanId: dto.basePlanId,
      tier: dto.tier || PlanTier.CUSTOM,
      billingCycle: dto.billingCycle || BillingCycle.MONTHLY,
      modules,
      monthlySubtotal,
      discountPercent: dto.discountPercent || 0,
      discountAmount: dto.discountAmount || 0,
      discountReason: dto.discountReason,
      monthlyTotal,
      currency: 'USD',
      status: CustomPlanStatus.DRAFT,
      validFrom: dto.validFrom,
      validTo: dto.validTo,
      notes: dto.notes,
      createdBy: dto.createdBy,
    });

    const saved = await this.planRepo.save(plan);
    this.logger.log(`Created custom plan ${saved.id} for tenant ${dto.tenantId}`);

    return saved;
  }

  /**
   * Get custom plan by ID
   */
  async getCustomPlan(planId: string): Promise<CustomPlan> {
    const plan = await this.planRepo.findOne({ where: { id: planId } });

    if (!plan) {
      throw new NotFoundException(`Custom plan not found: ${planId}`);
    }

    return plan;
  }

  /**
   * Get custom plan by tenant ID
   */
  async getCustomPlanByTenant(tenantId: string): Promise<CustomPlan | null> {
    return this.planRepo.findOne({
      where: {
        tenantId,
        status: CustomPlanStatus.ACTIVE,
      },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * List custom plans with filters
   */
  async listCustomPlans(filter: CustomPlanFilter): Promise<PaginatedResult<CustomPlan>> {
    const { tenantId, status, tier, search, page = 1, limit = 20 } = filter;

    const query = this.planRepo.createQueryBuilder('cp');

    if (tenantId) {
      query.andWhere('cp.tenant_id = :tenantId', { tenantId });
    }

    if (status) {
      query.andWhere('cp.status = :status', { status });
    }

    if (tier) {
      query.andWhere('cp.tier = :tier', { tier });
    }

    if (search) {
      query.andWhere('(cp.name ILIKE :search OR cp.description ILIKE :search)', {
        search: `%${search}%`,
      });
    }

    const [items, total] = await query
      .orderBy('cp.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Update custom plan
   */
  async updateCustomPlan(
    planId: string,
    dto: UpdateCustomPlanDto,
  ): Promise<CustomPlan> {
    const plan = await this.getCustomPlan(planId);

    if (!plan.canModify()) {
      throw new BadRequestException(
        `Cannot modify plan in status: ${plan.status}`,
      );
    }

    // Recalculate if modules changed
    if (dto.modules) {
      const { modules, monthlySubtotal, monthlyTotal } = await this.calculatePlanPricing(
        dto.modules,
        plan.tier,
        dto.discountPercent ?? plan.discountPercent,
        dto.discountAmount ?? plan.discountAmount,
      );

      plan.modules = modules;
      plan.monthlySubtotal = monthlySubtotal;
      plan.monthlyTotal = monthlyTotal;
    }

    // Update other fields
    if (dto.name !== undefined) plan.name = dto.name;
    if (dto.description !== undefined) plan.description = dto.description;
    if (dto.discountPercent !== undefined) plan.discountPercent = dto.discountPercent;
    if (dto.discountAmount !== undefined) plan.discountAmount = dto.discountAmount;
    if (dto.discountReason !== undefined) plan.discountReason = dto.discountReason;
    if (dto.validFrom !== undefined) plan.validFrom = dto.validFrom;
    if (dto.validTo !== undefined) plan.validTo = dto.validTo;
    if (dto.notes !== undefined) plan.notes = dto.notes;
    if (dto.updatedBy !== undefined) plan.updatedBy = dto.updatedBy;

    // Recalculate total if discounts changed
    if (dto.discountPercent !== undefined || dto.discountAmount !== undefined) {
      plan.monthlyTotal = this.calculateFinalTotal(
        plan.monthlySubtotal,
        plan.discountPercent,
        plan.discountAmount,
      );
    }

    const saved = await this.planRepo.save(plan);
    this.logger.log(`Updated custom plan ${planId}`);

    return saved;
  }

  /**
   * Submit plan for approval
   */
  async submitForApproval(planId: string): Promise<CustomPlan> {
    const plan = await this.getCustomPlan(planId);

    if (plan.status !== CustomPlanStatus.DRAFT) {
      throw new BadRequestException('Only draft plans can be submitted for approval');
    }

    if (plan.modules.length === 0) {
      throw new BadRequestException('Plan must have at least one module');
    }

    plan.status = CustomPlanStatus.PENDING_APPROVAL;
    const saved = await this.planRepo.save(plan);

    this.logger.log(`Plan ${planId} submitted for approval`);
    return saved;
  }

  /**
   * Approve custom plan
   */
  async approvePlan(planId: string, approverId: string): Promise<CustomPlan> {
    const plan = await this.getCustomPlan(planId);

    if (!plan.canApprove()) {
      throw new BadRequestException(
        `Cannot approve plan in status: ${plan.status}`,
      );
    }

    plan.status = CustomPlanStatus.APPROVED;
    plan.approvedBy = approverId;
    plan.approvedAt = new Date();

    const saved = await this.planRepo.save(plan);
    this.logger.log(`Plan ${planId} approved by ${approverId}`);

    return saved;
  }

  /**
   * Reject custom plan
   */
  async rejectPlan(
    planId: string,
    reason: string,
    rejectedBy: string,
  ): Promise<CustomPlan> {
    const plan = await this.getCustomPlan(planId);

    if (plan.status !== CustomPlanStatus.PENDING_APPROVAL) {
      throw new BadRequestException('Only pending plans can be rejected');
    }

    plan.status = CustomPlanStatus.REJECTED;
    plan.rejectionReason = reason;
    plan.updatedBy = rejectedBy;

    const saved = await this.planRepo.save(plan);
    this.logger.log(`Plan ${planId} rejected: ${reason}`);

    return saved;
  }

  /**
   * Activate custom plan (creates subscription)
   */
  async activatePlan(planId: string, activatedBy?: string): Promise<CustomPlan> {
    const plan = await this.getCustomPlan(planId);

    if (!plan.canActivate()) {
      throw new BadRequestException(
        `Cannot activate plan in status: ${plan.status}`,
      );
    }

    // Convert CustomPlanModules to SubscriptionModuleConfigs
    const moduleConfigs: SubscriptionModuleConfig[] = plan.modules.map((m) => ({
      moduleId: m.moduleId,
      moduleCode: m.moduleCode,
      moduleName: m.moduleName,
      quantities: m.quantities,
      lineItems: m.lineItems?.map((li) => ({
        metric: li.metric,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        total: li.total,
        description: li.description,
      })),
      subtotal: m.subtotal,
    }));

    // Create subscription using the SubscriptionManagementService
    const subscriptionResult = await this.subscriptionService.createSubscription({
      tenantId: plan.tenantId,
      planTier: plan.tier,
      billingCycle: plan.billingCycle,
      modules: moduleConfigs,
      monthlyTotal: plan.monthlyTotal,
      currency: plan.currency,
      createdBy: activatedBy,
    });

    if (!subscriptionResult.success) {
      throw new BadRequestException(
        `Failed to create subscription: ${subscriptionResult.message}`,
      );
    }

    plan.subscriptionId = subscriptionResult.subscription.id;
    plan.status = CustomPlanStatus.ACTIVE;
    const saved = await this.planRepo.save(plan);

    this.logger.log(
      `Plan ${planId} activated with subscription ${subscriptionResult.subscription.id}`,
    );
    return saved;
  }

  /**
   * Delete custom plan (only drafts)
   */
  async deletePlan(planId: string): Promise<void> {
    const plan = await this.getCustomPlan(planId);

    if (plan.status !== CustomPlanStatus.DRAFT) {
      throw new BadRequestException('Only draft plans can be deleted');
    }

    await this.planRepo.remove(plan);
    this.logger.log(`Plan ${planId} deleted`);
  }

  /**
   * Clone an existing plan
   */
  async clonePlan(planId: string, newTenantId: string): Promise<CustomPlan> {
    const sourcePlan = await this.getCustomPlan(planId);

    const clone = this.planRepo.create({
      ...sourcePlan,
      id: undefined,
      tenantId: newTenantId,
      name: `${sourcePlan.name} (Copy)`,
      status: CustomPlanStatus.DRAFT,
      approvedBy: null,
      approvedAt: null,
      subscriptionId: null,
      createdAt: undefined,
      updatedAt: undefined,
    });

    return this.planRepo.save(clone);
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * Calculate pricing for plan modules
   */
  private async calculatePlanPricing(
    moduleInputs: Array<{
      moduleId: string;
      moduleCode: string;
      moduleName: string;
      quantities: ModuleQuantities;
    }>,
    tier: PlanTier,
    discountPercent?: number,
    discountAmount?: number,
  ): Promise<{
    modules: CustomPlanModule[];
    monthlySubtotal: number;
    monthlyTotal: number;
  }> {
    const modules: CustomPlanModule[] = [];
    let monthlySubtotal = 0;

    for (const input of moduleInputs) {
      const pricing = await this.modulePricingService.getModulePricingByCode(
        input.moduleCode,
      );

      if (!pricing) {
        this.logger.warn(`No pricing for module: ${input.moduleCode}`);
        continue;
      }

      const tierMultiplier = pricing.getTierMultiplier(tier);
      const lineItems: CustomPlanLineItem[] = [];
      let moduleSubtotal = 0;

      // Calculate each metric
      for (const metric of pricing.pricingMetrics) {
        let quantity = 1;

        if (metric.type !== PricingMetricType.BASE_PRICE) {
          quantity = this.getQuantityForMetric(input.quantities, metric.type);
        }

        if (quantity === 0 && metric.type !== PricingMetricType.BASE_PRICE) {
          continue;
        }

        const includedQty = metric.includedQuantity ?? 0;
        const billableQty =
          metric.type === PricingMetricType.BASE_PRICE
            ? 1
            : Math.max(0, quantity - includedQty);

        const total = billableQty * metric.price * tierMultiplier;

        lineItems.push({
          metric: metric.type,
          description: PricingMetricLabels[metric.type] || metric.type,
          quantity,
          unitPrice: metric.price * tierMultiplier,
          total,
        });

        moduleSubtotal += total;
      }

      modules.push({
        moduleId: input.moduleId,
        moduleCode: input.moduleCode,
        moduleName: input.moduleName,
        quantities: input.quantities,
        lineItems,
        subtotal: moduleSubtotal,
      });

      monthlySubtotal += moduleSubtotal;
    }

    const monthlyTotal = this.calculateFinalTotal(
      monthlySubtotal,
      discountPercent,
      discountAmount,
    );

    return { modules, monthlySubtotal, monthlyTotal };
  }

  /**
   * Get quantity value for a metric type
   */
  private getQuantityForMetric(
    quantities: ModuleQuantities,
    metric: PricingMetricType,
  ): number {
    const map: Partial<Record<PricingMetricType, keyof ModuleQuantities>> = {
      [PricingMetricType.PER_USER]: 'users',
      [PricingMetricType.PER_FARM]: 'farms',
      [PricingMetricType.PER_POND]: 'ponds',
      [PricingMetricType.PER_SENSOR]: 'sensors',
      [PricingMetricType.PER_DEVICE]: 'devices',
      [PricingMetricType.PER_GB_STORAGE]: 'storageGb',
      [PricingMetricType.PER_API_CALL]: 'apiCalls',
      [PricingMetricType.PER_ALERT]: 'alerts',
      [PricingMetricType.PER_REPORT]: 'reports',
      [PricingMetricType.PER_INTEGRATION]: 'integrations',
    };

    const field = map[metric];
    return field ? quantities[field] ?? 0 : 0;
  }

  /**
   * Calculate final total with discounts
   */
  private calculateFinalTotal(
    subtotal: number,
    discountPercent?: number,
    discountAmount?: number,
  ): number {
    let total = subtotal;

    if (discountPercent && discountPercent > 0) {
      total -= total * (discountPercent / 100);
    }

    if (discountAmount && discountAmount > 0) {
      total -= discountAmount;
    }

    return Math.max(0, total);
  }
}
