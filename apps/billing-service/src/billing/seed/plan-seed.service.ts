import { TenantPlan } from '@platform/event-contracts';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { Plan } from '../entities/plan.entity';
import { PlanCyclePrice } from '../entities/plan-catalog.entity';
import { PlanTier, BillingCycle } from '../entities/subscription.entity';
import { billingPlanLimitsFor } from '../plan-limits.util';
import { cycleAmountFor, defaultCommitmentDiscountPercent } from '../services/module-quote';

/**
 * The default catalogue: ONE `billing.plans` row per tier, priced for EVERY
 * billing cycle.
 *
 * BILLING-CRITICAL-003. Two things were wrong here and they compounded:
 *
 *  1. The seed wrote MONTHLY rows only, and admin provisioning resolved a plan
 *     by `{tier, billingCycle}` against `plans`. So quarterly, semi-annual and
 *     annual provisioning every returned CATALOG_MISSING — three of the four
 *     cycles the platform offers could not be sold at all.
 *  2. Existing rows were matched by NAME. Identity is the tier: a rename
 *     through the catalogue UI made the seed insert a second "Starter", and
 *     four cycles under one name would have collided outright.
 *
 * The fix is not four rows per tier — that would re-fragment what the plan
 * catalogue normalised in W4b. One plan carries `plan_cycle_prices` rows, and
 * a cycle is OFFERED exactly when it has one. `plans.billing_cycle` is the
 * plan's DEFAULT cycle, not the only one it can be bought on.
 *
 * The per-cycle price comes from `cycleAmountFor` — the same function the
 * quote and the invoice use — so the catalogue cannot state a cycle price the
 * platform would not charge.
 *
 * A failure here is FATAL. It used to be a `logger.warn`, and a catalogue that
 * failed to seed makes every provisioning answer CATALOG_MISSING: the service
 * comes up healthy and sells nothing.
 */
@Injectable()
export class PlanSeedService implements OnModuleInit {
  private readonly logger = new Logger(PlanSeedService.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    await this.seedDefaultPlans();
  }

  private async seedDefaultPlans(): Promise<void> {
    // `Plan` and `PlanCyclePrice` are the cross-tenant platform catalogue —
    // no tenantId column, so a tenant-scoped repository would invent a scope
    // the schema does not have. The entity-first EntityManager overloads say
    // that in the call itself rather than through a suppressed lint rule.
    const manager = this.dataSource.manager;

    for (const definition of DEFAULT_PLANS) {
      const existing = await manager.findOne(Plan, {
        where: { tier: definition.tier, isDeleted: false },
        order: { version: 'DESC', sortOrder: 'ASC' },
        relations: { cyclePrices: true },
      });

      if (existing) {
        await this.ensureCyclePrices(existing, definition);
        continue;
      }

      const plan = manager.create(Plan, {
        name: definition.name,
        tier: definition.tier,
        basePrice: definition.monthlyBasePrice,
        currency: CURRENCY,
        // The DEFAULT cycle. Every cycle in `cyclePrices` is purchasable.
        billingCycle: BillingCycle.MONTHLY,
        limits: billingPlanLimitsFor(definition.limitsFrom),
        pricing: {
          basePrice: definition.monthlyBasePrice.toNumber(),
          perFarmPrice: definition.perFarmPrice.toNumber(),
          perSensorPrice: definition.perSensorPrice.toNumber(),
          perUserPrice: definition.perUserPrice.toNumber(),
          currency: CURRENCY,
        },
        features: {
          coreFeatures: [...definition.coreFeatures],
          advancedFeatures: [],
          premiumFeatures: [],
        },
        cyclePrices: cyclePricesFor(definition),
        isActive: true,
        isPublic: true,
        sortOrder: definition.sortOrder,
        createdBy: 'system',
        updatedBy: 'system',
      });
      await manager.save(Plan, plan);
      this.logger.log(
        `Seeded plan "${definition.name}" (${definition.tier}) priced for ` +
          `${cyclePricesFor(definition).length} billing cycles`,
      );
    }
  }

  /**
   * Bring an existing plan up to every cycle it should be purchasable on.
   *
   * This is the upgrade path for catalogues seeded before per-cycle pricing
   * existed. It only ADDS missing cycles — an operator's edited price is never
   * overwritten, which is the same promise the original seed made about names.
   */
  private async ensureCyclePrices(plan: Plan, definition: PlanDefinition): Promise<void> {
    const priced = new Set((plan.cyclePrices ?? []).map((price) => price.billingCycle));
    const missing = cyclePricesFor(definition).filter((price) => !priced.has(price.billingCycle));
    if (missing.length === 0) {
      return;
    }

    await this.dataSource.manager.save(
      PlanCyclePrice,
      missing.map((price) => ({ ...price, planId: plan.id })),
    );
    this.logger.log(
      `Plan "${plan.name}" (${plan.tier}) was purchasable on ${priced.size} of ` +
        `${priced.size + missing.length} cycles; added ` +
        `${missing.map((price) => price.billingCycle).join(', ')}`,
    );
  }
}

const CURRENCY = 'USD';

interface PlanDefinition {
  tier: PlanTier;
  name: string;
  limitsFrom: TenantPlan;
  /** The monthly rate. Every other cycle derives from it. */
  monthlyBasePrice: Decimal;
  perFarmPrice: Decimal;
  perSensorPrice: Decimal;
  perUserPrice: Decimal;
  coreFeatures: readonly string[];
  sortOrder: number;
}

/**
 * A price row per cycle, derived from the monthly rate by the ONE function the
 * quote and the invoice also use.
 *
 * `discountPercent` records the commitment discount actually applied, so the
 * catalogue row and the charge agree instead of the row carrying a number
 * nothing bills.
 */
interface SeedCyclePrice {
  billingCycle: BillingCycle;
  basePrice: Decimal;
  perUserPrice: Decimal;
  perFarmPrice: Decimal;
  perModulePrice: Decimal;
  discountPercent: Decimal;
}

function cyclePricesFor(definition: PlanDefinition): SeedCyclePrice[] {
  return Object.values(BillingCycle).map((billingCycle) => {
    // The ONLY reader of the platform default: from here on the plan's own
    // row is the authority, and a subscription snapshots it at the sale.
    const discountPercent = defaultCommitmentDiscountPercent(billingCycle);
    const priced = (monthly: Decimal): Decimal =>
      cycleAmountFor(monthly, billingCycle, CURRENCY, discountPercent).total;
    return {
      billingCycle,
      basePrice: priced(definition.monthlyBasePrice),
      perUserPrice: priced(definition.perUserPrice),
      perFarmPrice: priced(definition.perFarmPrice),
      perModulePrice: new Decimal(0),
      discountPercent,
    };
  });
}

const DEFAULT_PLANS: readonly PlanDefinition[] = [
  {
    // FREE — permanent $0 tier (Billing Revival Faz B). $0 base and $0
    // per-metric so the subscription total is $0 on every cycle. Limits
    // project from PLAN_CATALOG FREE via the SSoT.
    tier: PlanTier.FREE,
    name: 'Free',
    limitsFrom: TenantPlan.FREE,
    monthlyBasePrice: new Decimal(0),
    perFarmPrice: new Decimal(0),
    perSensorPrice: new Decimal(0),
    perUserPrice: new Decimal(0),
    coreFeatures: ['basic_monitoring', 'alerts'],
    sortOrder: 0,
  },
  {
    tier: PlanTier.STARTER,
    name: 'Starter',
    limitsFrom: TenantPlan.STARTER,
    monthlyBasePrice: new Decimal(49),
    perFarmPrice: new Decimal(10),
    perSensorPrice: new Decimal(2),
    perUserPrice: new Decimal(5),
    coreFeatures: ['basic_monitoring', 'alerts', 'dashboard'],
    sortOrder: 1,
  },
  {
    tier: PlanTier.PROFESSIONAL,
    name: 'Professional',
    limitsFrom: TenantPlan.PROFESSIONAL,
    monthlyBasePrice: new Decimal(149),
    perFarmPrice: new Decimal(15),
    perSensorPrice: new Decimal(3),
    perUserPrice: new Decimal(8),
    coreFeatures: [
      'basic_monitoring',
      'alerts',
      'dashboard',
      'reports',
      'api_access',
      'advanced_analytics',
    ],
    sortOrder: 2,
  },
  {
    tier: PlanTier.ENTERPRISE,
    name: 'Enterprise',
    limitsFrom: TenantPlan.ENTERPRISE,
    monthlyBasePrice: new Decimal(499),
    perFarmPrice: new Decimal(20),
    perSensorPrice: new Decimal(5),
    perUserPrice: new Decimal(10),
    coreFeatures: [
      'basic_monitoring',
      'alerts',
      'dashboard',
      'reports',
      'api_access',
      'advanced_analytics',
      'custom_integrations',
      'dedicated_support',
      'sla_guarantee',
      'white_label',
    ],
    sortOrder: 3,
  },
];
