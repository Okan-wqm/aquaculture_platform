/**
 * The plan catalogue, from the platform-admin side (ADR-0013,
 * BILLING-CRITICAL-002).
 *
 * `admin.plan_definitions` is gone. It was a second catalogue whose ids no
 * runtime path resolved — create-subscription, change-plan, the billing
 * scheduler and the provisioning handler all read `billing.plans` — with its
 * own Stripe product and price ids and a per-cycle price matrix inside a jsonb
 * column. admin-api keeps the PlanManagement page: it reads the read-only
 * mapping of `billing.plans` and authors through `request.billing.admin.*Plan`.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type {
  BillingCycle,
  BillingPlanInput,
  BillingPlanSnapshot,
  BillingPlanTier,
  BillingPlanUpdateInput,
} from '@platform/event-contracts';
import Decimal from 'decimal.js';
import { Not, Repository } from 'typeorm';

import { adminPlanLimitsFor } from '../plan-limits.util';
import {
  PlanComparisonResponseDto,
  PlanCyclePriceResponseDto,
  PlanLimitsResponseDto,
  PlanResponseDto,
  ProratedPricingResponseDto,
} from '../dto/plan-response.dto';
import { PlanReadOnly } from '../entities/external/plan.entity';

import { BillingAdminCommandClientService } from './billing-admin-command-client.service';

const DAYS_PER_CYCLE: Readonly<Record<BillingCycle, number>> = {
  monthly: 30,
  quarterly: 90,
  semi_annual: 180,
  annual: 365,
};

const COUNTED_LIMITS = [
  'maxUsers',
  'maxFarms',
  'maxPonds',
  'maxSensors',
  'maxModules',
  'storageGB',
  'dataRetentionDays',
  'apiRateLimit',
] as const;

const FLAG_LIMITS = [
  'alertsEnabled',
  'reportsEnabled',
  'customBrandingEnabled',
  'apiAccessEnabled',
  'customIntegrationsEnabled',
  'ssoEnabled',
  'auditLogEnabled',
  'prioritySupport',
  'dedicatedAccountManager',
] as const;

@Injectable()
export class PlanDefinitionService {
  private readonly logger = new Logger(PlanDefinitionService.name);

  constructor(
    @InjectRepository(PlanReadOnly)
    private readonly plans: Repository<PlanReadOnly>,
    private readonly billingCommands: BillingAdminCommandClientService,
  ) {}

  // ── Reads (billing's rows, read-only) ──────────────────────────────────

  async findAll(includeInactive = false): Promise<PlanResponseDto[]> {
    const rows = await this.plans.find({
      where: includeInactive ? { isDeleted: false } : { isDeleted: false, isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
    return rows.map(toPlanResponse);
  }

  /** What a prospective customer would be shown: public, active, not retired. */
  async findPublicPlans(): Promise<PlanResponseDto[]> {
    const rows = await this.plans.find({
      where: { isDeleted: false, isActive: true, visibility: 'public' },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
    return rows.map(toPlanResponse);
  }

  async findById(id: string): Promise<PlanResponseDto> {
    return toPlanResponse(await this.requireById(id));
  }

  async findByCode(code: string): Promise<PlanResponseDto> {
    const found = await this.plans.findOne({ where: { code, isDeleted: false } });
    if (!found) throw new NotFoundException(`Plan with code ${code} not found`);
    return toPlanResponse(found);
  }

  async findByTier(tier: BillingPlanTier): Promise<PlanResponseDto | null> {
    const found = await this.plans.findOne({
      where: { tier, isDeleted: false, isActive: true },
      order: { sortOrder: 'ASC' },
    });
    return found ? toPlanResponse(found) : null;
  }

  /**
   * The canonical limits for a tier, projected from `PLAN_CATALOG` (ADR-037).
   * Not read from a plan row: the catalogue is the limit SSoT, and a plan
   * projects from it rather than defining it.
   */
  getDefaultLimitsForTier(tier: BillingPlanTier): PlanLimitsResponseDto {
    return adminPlanLimitsFor(tier);
  }

  // ── Writes (forwarded to billing) ──────────────────────────────────────

  async create(input: BillingPlanInput, actorId: string): Promise<PlanResponseDto> {
    return fromPlanSnapshot(await this.billingCommands.createPlan(input, actorId));
  }

  async update(
    planId: string,
    input: BillingPlanUpdateInput,
    actorId: string,
  ): Promise<PlanResponseDto> {
    return fromPlanSnapshot(await this.billingCommands.updatePlan(planId, input, actorId));
  }

  async deprecate(planId: string, actorId: string): Promise<PlanResponseDto> {
    return fromPlanSnapshot(await this.billingCommands.deprecatePlan(planId, actorId));
  }

  // ── Comparison and proration (reads only) ──────────────────────────────

  /**
   * What changes between two plans.
   *
   * Reads `billing.plans` — the only catalogue — and compares monthly prices
   * in `Decimal`. The float version could report a difference of
   * 0.010000000000047748 between $1,199.99 and $1,200.00.
   */
  async comparePlans(
    currentPlanId: string,
    newPlanId: string,
  ): Promise<PlanComparisonResponseDto> {
    const [currentPlan, newPlan] = await Promise.all([
      this.requireById(currentPlanId),
      this.requireById(newPlanId),
    ]);

    const priceDifference = monthlyPriceOf(newPlan).minus(monthlyPriceOf(currentPlan));

    const limitChanges = COUNTED_LIMITS.map((limit) => {
      const currentValue = Number(currentPlan.limits[limit] ?? 0);
      const newValue = Number(newPlan.limits[limit] ?? 0);
      // `-1` is unlimited, so it compares as the largest value, not the smallest.
      let change: 'increase' | 'decrease' | 'same' = 'same';
      if (newValue > currentValue || (currentValue !== -1 && newValue === -1)) change = 'increase';
      else if (newValue < currentValue || (currentValue === -1 && newValue !== -1)) {
        change = 'decrease';
      }
      return { limit, currentValue, newValue, change };
    });

    const featureChanges: Array<{ feature: string; gaining: boolean }> = [];
    for (const feature of FLAG_LIMITS) {
      const currentHas = Boolean(currentPlan.limits[feature]);
      const newHas = Boolean(newPlan.limits[feature]);
      if (currentHas !== newHas) featureChanges.push({ feature, gaining: newHas });
    }

    const hasDecrease =
      limitChanges.some((c) => c.change === 'decrease') ||
      featureChanges.some((c) => !c.gaining);
    const hasIncrease =
      limitChanges.some((c) => c.change === 'increase') || featureChanges.some((c) => c.gaining);
    const samePrice = priceDifference.isZero();

    const isUpgrade = priceDifference.isPositive() && !samePrice
      ? true
      : samePrice && hasIncrease && !hasDecrease;
    const isDowngrade = priceDifference.isNegative()
      ? true
      : samePrice && hasDecrease && !hasIncrease;

    const warnings: string[] = [];
    if (isDowngrade) {
      warnings.push(
        newPlan.downgradeWarning ||
          'Downgrading may result in loss of features or data.',
      );
      const lost = featureChanges.filter((c) => !c.gaining);
      if (lost.length > 0) {
        warnings.push(`You will lose access to: ${lost.map((f) => f.feature).join(', ')}`);
      }
      for (const limit of limitChanges.filter((c) => c.change === 'decrease')) {
        if (limit.limit === 'maxUsers') {
          warnings.push(
            `User limit will decrease from ${limit.currentValue === -1 ? 'unlimited' : limit.currentValue} to ${limit.newValue}`,
          );
        }
      }
    }

    return {
      isUpgrade,
      isDowngrade,
      priceDifference: priceDifference.toString(),
      limitChanges: [...limitChanges],
      featureChanges,
      warnings,
    };
  }

  /**
   * What a mid-cycle plan change would cost, pro-rated by the days remaining.
   *
   * DEBT (owner okan, deadline 2026-12-31, BILLING-CRITICAL-003): billing's
   * `ChangeSubscriptionPlanHandler` computes its own proration when the change
   * is actually applied, so this preview is a second implementation of the same
   * money rule. It moves to billing with the rest of the subscription money
   * path under that finding; it is at least exact now, and it reads the one
   * catalogue.
   */
  calculateProratedPricing(
    currentPlan: PlanResponseDto,
    newPlan: PlanResponseDto,
    currentPeriodEnd: Date,
    billingCycle: BillingCycle,
  ): ProratedPricingResponseDto {
    const now = new Date();
    const daysRemaining = Math.max(
      0,
      Math.ceil((currentPeriodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
    );
    const cycleDays = DAYS_PER_CYCLE[billingCycle] ?? DAYS_PER_CYCLE.monthly;
    const remainingShare = new Decimal(daysRemaining).dividedBy(cycleDays);

    const currentPrice = priceForCycle(currentPlan, billingCycle);
    const newPrice = priceForCycle(newPlan, billingCycle);
    const currentPlanCredit = currentPrice.times(remainingShare).toDecimalPlaces(2);
    const newPlanCost = newPrice.times(remainingShare).toDecimalPlaces(2);

    return {
      currentPlanCredit: currentPlanCredit.toString(),
      newPlanCost: newPlanCost.toString(),
      // Positive = the customer pays, negative = they are credited.
      proratedAmount: newPlanCost.minus(currentPlanCredit).toString(),
      daysRemaining,
      effectiveDate: now.toISOString(),
    };
  }

  private async requireById(id: string): Promise<PlanReadOnly> {
    const found = await this.plans.findOne({ where: { id, isDeleted: false } });
    if (!found) throw new NotFoundException(`Plan with ID ${id} not found`);
    return found;
  }
}

function monthlyPriceOf(plan: PlanReadOnly): Decimal {
  const monthly = (plan.cyclePrices ?? []).find((price) => price.billingCycle === 'monthly');
  return monthly?.basePrice ?? new Decimal(0);
}

function priceForCycle(plan: PlanResponseDto, billingCycle: BillingCycle): Decimal {
  const row = plan.cyclePrices.find((price) => price.billingCycle === billingCycle);
  return new Decimal(row?.basePrice ?? plan.cyclePrices[0]?.basePrice ?? '0');
}

/**
 * A read of billing's catalogue becomes the same wire shape a write returns.
 * `Decimal` fields become their exact decimal string — the value the client
 * would have received anyway through `toJSON`, now stated in the type.
 */
function toPlanResponse(plan: PlanReadOnly): PlanResponseDto {
  const cyclePrices: PlanCyclePriceResponseDto[] = (plan.cyclePrices ?? []).map((price) => ({
    billingCycle: price.billingCycle,
    basePrice: price.basePrice.toString(),
    perUserPrice: price.perUserPrice.toString(),
    perFarmPrice: price.perFarmPrice.toString(),
    perModulePrice: price.perModulePrice.toString(),
    discountPercent: price.discountPercent.toString(),
  }));

  return {
    id: plan.id,
    code: plan.code ?? undefined,
    name: plan.name,
    description: plan.description ?? undefined,
    shortDescription: plan.shortDescription ?? undefined,
    tier: plan.tier,
    currency: plan.currency,
    defaultBillingCycle: plan.billingCycle,
    visibility: plan.visibility,
    isActive: plan.isActive,
    isRecommended: plan.isRecommended,
    sortOrder: plan.sortOrder,
    limits: plan.limits,
    features: plan.features,
    cyclePrices,
    addOns: (plan.addOns ?? []).map((addOn) => ({
      code: addOn.code,
      name: addOn.name,
      description: addOn.description ?? undefined,
      price: addOn.price.toString(),
      billingCycle: addOn.billingCycle,
    })),
    trialDays: plan.trialDays ?? undefined,
    gracePeriodDays: plan.gracePeriodDays ?? undefined,
    upgradeMessage: plan.upgradeMessage ?? undefined,
    downgradeWarning: plan.downgradeWarning ?? undefined,
    icon: plan.icon ?? undefined,
    color: plan.color ?? undefined,
    badge: plan.badge ?? undefined,
    stripeProductId: plan.stripeProductId ?? undefined,
    stripePriceIds: plan.stripePriceIds ?? undefined,
    version: plan.version,
    createdAt: new Date(plan.createdAt).toISOString(),
    updatedAt: new Date(plan.updatedAt).toISOString(),
    createdBy: plan.createdBy ?? undefined,
    updatedBy: plan.updatedBy ?? undefined,
  };
}

/** billing's command reply, in the same wire shape as a read. */
function fromPlanSnapshot(snapshot: BillingPlanSnapshot): PlanResponseDto {
  return {
    id: snapshot.id,
    code: snapshot.code ?? undefined,
    name: snapshot.name,
    description: snapshot.description ?? undefined,
    shortDescription: snapshot.shortDescription ?? undefined,
    tier: snapshot.tier,
    currency: snapshot.currency,
    defaultBillingCycle: snapshot.defaultBillingCycle,
    visibility: snapshot.visibility,
    isActive: snapshot.isActive,
    isRecommended: snapshot.isRecommended,
    sortOrder: snapshot.sortOrder,
    limits: snapshot.limits,
    features: snapshot.features,
    cyclePrices: snapshot.cyclePrices,
    addOns: snapshot.addOns,
    trialDays: snapshot.trialDays ?? undefined,
    gracePeriodDays: snapshot.gracePeriodDays ?? undefined,
    upgradeMessage: snapshot.upgradeMessage ?? undefined,
    downgradeWarning: snapshot.downgradeWarning ?? undefined,
    icon: snapshot.icon ?? undefined,
    color: snapshot.color ?? undefined,
    badge: snapshot.badge ?? undefined,
    stripeProductId: snapshot.stripeProductId ?? undefined,
    stripePriceIds: snapshot.stripePriceIds ?? undefined,
    version: snapshot.version,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    createdBy: snapshot.createdBy ?? undefined,
    updatedBy: snapshot.updatedBy ?? undefined,
  };
}
