/**
 * The plan catalogue writer — billing is the only one (ADR-0013,
 * BILLING-CRITICAL-002).
 *
 * `admin.plan_definitions` was a second catalogue whose ids no runtime path
 * ever resolved: create-subscription, change-plan, the scheduler and the
 * provisioning handler all read `billing.plans`. It is gone, and admin-api
 * authors through the `request.billing.admin.*Plan` commands instead.
 *
 * A plan is never edited in place where money is concerned: `cyclePrices` and
 * `addOns` are replaced wholesale inside the same transaction as the plan
 * update, so a partially-applied price change cannot be observed.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import type {
  BillingCycle as ContractBillingCycle,
  BillingPlanCyclePriceInput,
  BillingPlanInput,
  BillingPlanSnapshot,
  BillingPlanUpdateInput,
  BillingPlanVisibility as ContractPlanVisibility,
} from '@platform/event-contracts';
import Decimal from 'decimal.js';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { PlanAddOn, PlanCyclePrice } from '../entities/plan-catalog.entity';
import { Plan, PlanVisibility } from '../entities/plan.entity';
import { BillingCycle, PlanTier } from '../entities/subscription.entity';

/**
 * The contract carries a billing cycle as a string literal; the entity column
 * is a TypeScript `enum`, whose members are nominal and therefore NOT
 * assignable from those literals. This map is the boundary, and it is
 * exhaustive over the contract union — a cycle added there is a compile error
 * here rather than a value that silently fails to persist.
 */
const CYCLE_BY_WIRE_VALUE: Readonly<Record<ContractBillingCycle, BillingCycle>> = {
  monthly: BillingCycle.MONTHLY,
  quarterly: BillingCycle.QUARTERLY,
  semi_annual: BillingCycle.SEMI_ANNUAL,
  annual: BillingCycle.ANNUAL,
};

function toCycle(wire: ContractBillingCycle): BillingCycle {
  const cycle = CYCLE_BY_WIRE_VALUE[wire];
  if (!cycle) throw new BadRequestException(`Unknown billing cycle ${String(wire)}`);
  return cycle;
}

/**
 * The same boundary in the other direction, exhaustive for the same reason: a
 * TypeScript string enum member is NOT assignable to the contract's
 * string-literal union, so a value crossing back out has to be mapped rather
 * than assumed.
 */
const WIRE_VALUE_BY_CYCLE: Readonly<Record<BillingCycle, ContractBillingCycle>> = {
  [BillingCycle.MONTHLY]: 'monthly',
  [BillingCycle.QUARTERLY]: 'quarterly',
  [BillingCycle.SEMI_ANNUAL]: 'semi_annual',
  [BillingCycle.ANNUAL]: 'annual',
};

/** The same boundary for visibility, and exhaustive for the same reason. */
const VISIBILITY_BY_WIRE_VALUE: Readonly<Record<ContractPlanVisibility, PlanVisibility>> = {
  public: PlanVisibility.PUBLIC,
  private: PlanVisibility.PRIVATE,
  deprecated: PlanVisibility.DEPRECATED,
};

function toVisibility(wire: ContractPlanVisibility | undefined): PlanVisibility {
  return wire === undefined ? PlanVisibility.PUBLIC : VISIBILITY_BY_WIRE_VALUE[wire];
}

/**
 * The plan's terms for one billing cycle.
 *
 * A plan is purchasable on a cycle exactly when this row exists — W4b
 * normalised the per-cycle matrix into `plan_cycle_prices`, and
 * `plans.billing_cycle` is only the plan's DEFAULT cycle. The row also carries
 * the commitment discount the sale is priced at (BILLING-CRITICAL-003).
 */
export function cyclePriceOf(plan: Plan, billingCycle: BillingCycle): PlanCyclePrice | undefined {
  return (plan.cyclePrices ?? []).find((price) => price.billingCycle === billingCycle);
}

@Injectable()
export class PlanCatalogService {
  private readonly logger = new Logger(PlanCatalogService.name);

  constructor(
    @InjectRepository(Plan)
    private readonly plans: Repository<Plan>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * The commitment discount a NEW sale on this tier would carry, per cycle
   * (BILLING-CRITICAL-003).
   *
   * The quote and the sale must agree, so both read the plan's own
   * `plan_cycle_prices.discount_percent` — the platform-wide constant is a
   * seed default, not the authority. An absent plan yields no commitment
   * terms, which is consistent: provisioning refuses that tier too.
   */
  async commitmentDiscountsFor(
    tier: PlanTier,
  ): Promise<ReadonlyMap<ContractBillingCycle, Decimal>> {
    const plan = await this.plans.findOne({
      where: { tier, isActive: true, isDeleted: false },
      order: { version: 'DESC', sortOrder: 'ASC' },
      relations: { cyclePrices: true },
    });
    return new Map(
      (plan?.cyclePrices ?? []).map((price) => [
        WIRE_VALUE_BY_CYCLE[price.billingCycle],
        price.discountPercent,
      ]),
    );
  }

  /**
   * The priced children are loaded with the plan, always. `toPlanSnapshot`
   * reads `cyclePrices` and `addOns`; a plan fetched without them serialises
   * as a plan with no prices, which is indistinguishable on the wire from a
   * plan that genuinely has none.
   */
  async findById(planId: string): Promise<Plan> {
    const found = await this.plans.findOne({
      where: { id: planId, isDeleted: false },
      relations: { cyclePrices: true, addOns: true },
    });
    if (!found) throw new NotFoundException(`Plan ${planId} not found`);
    return found;
  }

  async create(input: BillingPlanInput, actorId: string): Promise<Plan> {
    this.assertValid(input);
    const name = input.name.trim();

    if (await this.plans.findOne({ where: { name } })) {
      throw new ConflictException(`A plan named "${name}" already exists`);
    }
    if (input.code && (await this.plans.findOne({ where: { code: input.code } }))) {
      throw new ConflictException(`A plan with code "${input.code}" already exists`);
    }

    return this.dataSource.transaction(async (manager) => {
      const monthly = monthlyPriceOf(input.cyclePrices);
      const currency = (input.currency ?? 'USD').toUpperCase();
      const plan = manager.create(Plan, {
        name,
        code: input.code ?? null,
        description: input.description ?? null,
        shortDescription: input.shortDescription ?? null,
        tier: input.tier,
        currency,
        billingCycle: input.defaultBillingCycle
          ? toCycle(input.defaultBillingCycle)
          : BillingCycle.MONTHLY,
        visibility: toVisibility(input.visibility),
        isRecommended: input.isRecommended ?? false,
        basePrice: monthly,
        // The flat per-unit rate card a subscription snapshots at signup. It
        // is the same shape as `billing.subscriptions.pricing`; normalising it
        // is BILLING-CRITICAL-003's, together with that snapshot.
        pricing: {
          basePrice: monthly.toNumber(),
          perUserPrice: perUnitOf(input.cyclePrices, 'perUserPrice'),
          perFarmPrice: perUnitOf(input.cyclePrices, 'perFarmPrice'),
          perSensorPrice: 0,
          currency,
        },
        limits: input.limits,
        features: input.features ?? {
          coreFeatures: [],
          advancedFeatures: [],
          premiumFeatures: [],
        },
        isActive: true,
        isPublic: toVisibility(input.visibility) === PlanVisibility.PUBLIC,
        sortOrder: input.sortOrder ?? 0,
        trialDays: input.trialDays ?? null,
        gracePeriodDays: input.gracePeriodDays ?? null,
        upgradeMessage: input.upgradeMessage ?? null,
        downgradeWarning: input.downgradeWarning ?? null,
        icon: input.icon ?? null,
        color: input.color ?? null,
        badge: input.badge ?? null,
        stripeProductId: input.stripeProductId ?? null,
        stripePriceIds: input.stripePriceIds ?? null,
        createdBy: actorId,
        updatedBy: actorId,
      });
      const saved = await manager.save(plan);
      await this.replaceChildren(manager, saved.id, input);

      this.logger.log(JSON.stringify({ event: 'plan.created', planId: saved.id, name, actorId }));
      return this.reload(manager, saved.id);
    });
  }

  async update(planId: string, input: BillingPlanUpdateInput, actorId: string): Promise<Plan> {
    const existing = await this.findById(planId);
    if (input.cyclePrices) this.assertCyclePrices(input.cyclePrices);
    if (input.name !== undefined) {
      const name = input.name.trim();
      const clash = await this.plans.findOne({ where: { name } });
      if (clash && clash.id !== planId) {
        throw new ConflictException(`A plan named "${name}" already exists`);
      }
    }

    return this.dataSource.transaction(async (manager) => {
      if (input.name !== undefined) existing.name = input.name.trim();
      if (input.code !== undefined) existing.code = input.code;
      if (input.description !== undefined) existing.description = input.description;
      if (input.shortDescription !== undefined) {
        existing.shortDescription = input.shortDescription;
      }
      if (input.tier !== undefined) existing.tier = input.tier;
      if (input.currency !== undefined) existing.currency = input.currency.toUpperCase();
      if (input.defaultBillingCycle !== undefined) {
        existing.billingCycle = toCycle(input.defaultBillingCycle);
      }
      if (input.visibility !== undefined) {
        existing.visibility = toVisibility(input.visibility);
        existing.isPublic = existing.visibility === PlanVisibility.PUBLIC;
      }
      if (input.isActive !== undefined) existing.isActive = input.isActive;
      if (input.isRecommended !== undefined) existing.isRecommended = input.isRecommended;
      if (input.sortOrder !== undefined) existing.sortOrder = input.sortOrder;
      if (input.limits !== undefined) existing.limits = input.limits;
      if (input.features !== undefined) existing.features = input.features;
      if (input.trialDays !== undefined) existing.trialDays = input.trialDays;
      if (input.gracePeriodDays !== undefined) existing.gracePeriodDays = input.gracePeriodDays;
      if (input.upgradeMessage !== undefined) existing.upgradeMessage = input.upgradeMessage;
      if (input.downgradeWarning !== undefined) {
        existing.downgradeWarning = input.downgradeWarning;
      }
      if (input.icon !== undefined) existing.icon = input.icon;
      if (input.color !== undefined) existing.color = input.color;
      if (input.badge !== undefined) existing.badge = input.badge;
      if (input.stripeProductId !== undefined) existing.stripeProductId = input.stripeProductId;
      if (input.stripePriceIds !== undefined) existing.stripePriceIds = input.stripePriceIds;

      if (input.cyclePrices) {
        const monthly = monthlyPriceOf(input.cyclePrices);
        existing.basePrice = monthly;
        existing.pricing = {
          basePrice: monthly.toNumber(),
          perUserPrice: perUnitOf(input.cyclePrices, 'perUserPrice'),
          perFarmPrice: perUnitOf(input.cyclePrices, 'perFarmPrice'),
          perSensorPrice: existing.pricing?.perSensorPrice ?? 0,
          currency: existing.currency,
        };
      }
      existing.updatedBy = actorId;
      await manager.save(existing);

      if (input.cyclePrices || input.addOns) {
        await this.replaceChildren(manager, planId, {
          cyclePrices: input.cyclePrices ?? [],
          addOns: input.addOns,
        });
      }

      this.logger.log(JSON.stringify({ event: 'plan.updated', planId, actorId }));
      return this.reload(manager, planId);
    });
  }

  /**
   * Retire a plan from sale. Never a delete: live subscriptions reference the
   * row, so it becomes invisible and unsellable while staying resolvable.
   */
  async deprecate(planId: string, actorId: string): Promise<Plan> {
    const plan = await this.findById(planId);
    plan.visibility = PlanVisibility.DEPRECATED;
    plan.isPublic = false;
    plan.isActive = false;
    plan.updatedBy = actorId;
    await this.plans.save(plan);
    this.logger.log(JSON.stringify({ event: 'plan.deprecated', planId, actorId }));
    // Re-read rather than returning `save`'s result: `save` returns what it was
    // given, so the reply would carry whatever relations happened to be loaded.
    return this.findById(planId);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /**
   * Replace the priced children wholesale, in the caller's transaction.
   *
   * A price change is all-or-nothing: deleting and re-inserting inside one
   * transaction means no reader can observe a plan priced half old and half
   * new, which a row-by-row upsert would allow.
   */
  private async replaceChildren(
    manager: EntityManager,
    planId: string,
    input: Pick<BillingPlanInput, 'cyclePrices' | 'addOns'>,
  ): Promise<void> {
    if (input.cyclePrices.length > 0) {
      await manager.delete(PlanCyclePrice, { planId });
      await manager.save(
        input.cyclePrices.map((price) =>
          manager.create(PlanCyclePrice, {
            planId,
            billingCycle: toCycle(price.billingCycle),
            basePrice: new Decimal(price.basePrice),
            perUserPrice: new Decimal(price.perUserPrice),
            perFarmPrice: new Decimal(price.perFarmPrice),
            perModulePrice: new Decimal(price.perModulePrice),
            discountPercent: new Decimal(price.discountPercent),
          }),
        ),
      );
    }

    if (input.addOns) {
      await manager.delete(PlanAddOn, { planId });
      if (input.addOns.length > 0) {
        await manager.save(
          input.addOns.map((addOn) =>
            manager.create(PlanAddOn, {
              planId,
              code: addOn.code,
              name: addOn.name,
              description: addOn.description ?? null,
              price: new Decimal(addOn.price),
              billingCycle: toCycle(addOn.billingCycle),
            }),
          ),
        );
      }
    }
  }

  private async reload(manager: EntityManager, planId: string): Promise<Plan> {
    const reloaded = await manager.findOne(Plan, {
      where: { id: planId },
      relations: { cyclePrices: true, addOns: true },
    });
    if (!reloaded) throw new Error('plan vanished within its own transaction');
    return reloaded;
  }

  private assertValid(input: BillingPlanInput): void {
    if (!input.name.trim()) throw new BadRequestException('A plan needs a name');
    const currency = (input.currency ?? 'USD').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new BadRequestException('currency must be an ISO-4217 code');
    }
    this.assertCyclePrices(input.cyclePrices);
    for (const addOn of input.addOns ?? []) {
      if (new Decimal(addOn.price).isNegative()) {
        throw new BadRequestException(`Add-on ${addOn.code} has a negative price`);
      }
    }
  }

  /**
   * A plan must price at least one cycle, price each at most once, and price
   * none of them negatively or at a discount outside [0, 100] — the same
   * constraints `billing.plan_cycle_prices` CHECKs, said in words.
   */
  private assertCyclePrices(cyclePrices: BillingPlanCyclePriceInput[]): void {
    if (cyclePrices.length === 0) {
      throw new BadRequestException('A plan must price at least one billing cycle');
    }
    const seen = new Set<ContractBillingCycle>();
    for (const price of cyclePrices) {
      if (!(price.billingCycle in CYCLE_BY_WIRE_VALUE)) {
        throw new BadRequestException(`Unknown billing cycle ${String(price.billingCycle)}`);
      }
      if (seen.has(price.billingCycle)) {
        throw new BadRequestException(`Billing cycle ${price.billingCycle} is priced twice`);
      }
      seen.add(price.billingCycle);
      for (const field of [
        'basePrice',
        'perUserPrice',
        'perFarmPrice',
        'perModulePrice',
      ] as const) {
        if (new Decimal(price[field]).isNegative()) {
          throw new BadRequestException(`${price.billingCycle} ${field} is negative`);
        }
      }
      const discount = new Decimal(price.discountPercent);
      if (discount.isNegative() || discount.greaterThan(100)) {
        throw new BadRequestException(
          `${price.billingCycle} discountPercent must be between 0 and 100`,
        );
      }
    }
  }
}

/** The monthly base price, which the flat rate card and `base_price` mirror. */
function monthlyPriceOf(cyclePrices: BillingPlanCyclePriceInput[]): Decimal {
  const monthly = cyclePrices.find((price) => price.billingCycle === 'monthly');
  return new Decimal(monthly?.basePrice ?? cyclePrices[0]?.basePrice ?? '0');
}

function perUnitOf(
  cyclePrices: BillingPlanCyclePriceInput[],
  field: 'perUserPrice' | 'perFarmPrice',
): number {
  const monthly = cyclePrices.find((price) => price.billingCycle === 'monthly');
  return Number(monthly?.[field] ?? cyclePrices[0]?.[field] ?? '0');
}

/** The wire shape of a plan — the one place a row becomes a snapshot. */
export function toPlanSnapshot(plan: Plan): BillingPlanSnapshot {
  return {
    id: plan.id,
    code: plan.code ?? null,
    name: plan.name,
    description: plan.description ?? null,
    shortDescription: plan.shortDescription ?? null,
    tier: plan.tier,
    currency: plan.currency,
    defaultBillingCycle: plan.billingCycle,
    visibility: plan.visibility,
    isActive: plan.isActive,
    isRecommended: plan.isRecommended,
    sortOrder: plan.sortOrder,
    limits: plan.limits as BillingPlanSnapshot['limits'],
    features: plan.features,
    cyclePrices: (plan.cyclePrices ?? []).map((price) => ({
      billingCycle: price.billingCycle,
      basePrice: price.basePrice.toString(),
      perUserPrice: price.perUserPrice.toString(),
      perFarmPrice: price.perFarmPrice.toString(),
      perModulePrice: price.perModulePrice.toString(),
      discountPercent: price.discountPercent.toString(),
    })),
    addOns: (plan.addOns ?? []).map((addOn) => ({
      code: addOn.code,
      name: addOn.name,
      description: addOn.description ?? undefined,
      price: addOn.price.toString(),
      billingCycle: addOn.billingCycle,
    })),
    trialDays: plan.trialDays ?? null,
    gracePeriodDays: plan.gracePeriodDays ?? null,
    upgradeMessage: plan.upgradeMessage ?? null,
    downgradeWarning: plan.downgradeWarning ?? null,
    icon: plan.icon ?? null,
    color: plan.color ?? null,
    badge: plan.badge ?? null,
    stripeProductId: plan.stripeProductId ?? null,
    stripePriceIds: plan.stripePriceIds ?? null,
    version: plan.version,
    createdAt: new Date(plan.createdAt).toISOString(),
    updatedAt: new Date(plan.updatedAt).toISOString(),
    createdBy: plan.createdBy ?? null,
    updatedBy: plan.updatedBy ?? null,
  };
}
