import { TenantPlan } from '@platform/event-contracts';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { Plan } from '../entities/plan.entity';
import { PlanTier, BillingCycle } from '../entities/subscription.entity';
import { billingPlanLimitsFor } from '../plan-limits.util';

/**
 * Seeds the default plans into the database on application startup.
 *
 * Uses upsert semantics: existing plans (matched by name) are NOT overwritten,
 * so manual edits via the admin CRUD API are preserved.
 *
 * Plans are database-driven; provisioning resolves subscription pricing from
 * admin-api's PricingCalculatorService (admin.module_pricing), not from any
 * hardcoded per-tier constants.
 */
@Injectable()
export class PlanSeedService implements OnModuleInit {
  private readonly logger = new Logger(PlanSeedService.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    await this.seedDefaultPlans();
  }

  private async seedDefaultPlans(): Promise<void> {
    // Plan is the cross-tenant platform catalog; seed runs as platform admin.
    // eslint-disable-next-line no-restricted-syntax -- cross-tenant catalog
    const planRepo = this.dataSource.getRepository(Plan);

    const defaultPlans: Partial<Plan>[] = [
      {
        name: 'Starter',
        tier: PlanTier.STARTER,
        basePrice: new Decimal(49),
        currency: 'USD',
        billingCycle: BillingCycle.MONTHLY,
        limits: billingPlanLimitsFor(TenantPlan.STARTER),
        pricing: {
          basePrice: 49,
          perFarmPrice: 10,
          perSensorPrice: 2,
          perUserPrice: 5,
          currency: 'USD',
        },
        features: [
          'basic_monitoring',
          'alerts',
          'dashboard',
        ],
        isActive: true,
        isPublic: true,
        sortOrder: 1,
        createdBy: 'system',
        updatedBy: 'system',
      },
      {
        name: 'Professional',
        tier: PlanTier.PROFESSIONAL,
        basePrice: new Decimal(149),
        currency: 'USD',
        billingCycle: BillingCycle.MONTHLY,
        limits: billingPlanLimitsFor(TenantPlan.PROFESSIONAL),
        pricing: {
          basePrice: 149,
          perFarmPrice: 15,
          perSensorPrice: 3,
          perUserPrice: 8,
          currency: 'USD',
        },
        features: [
          'basic_monitoring',
          'alerts',
          'dashboard',
          'reports',
          'api_access',
          'advanced_analytics',
        ],
        isActive: true,
        isPublic: true,
        sortOrder: 2,
        createdBy: 'system',
        updatedBy: 'system',
      },
      {
        name: 'Enterprise',
        tier: PlanTier.ENTERPRISE,
        basePrice: new Decimal(499),
        currency: 'USD',
        billingCycle: BillingCycle.MONTHLY,
        limits: billingPlanLimitsFor(TenantPlan.ENTERPRISE),
        pricing: {
          basePrice: 499,
          perFarmPrice: 20,
          perSensorPrice: 5,
          perUserPrice: 10,
          currency: 'USD',
        },
        features: [
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
        isActive: true,
        isPublic: true,
        sortOrder: 3,
        createdBy: 'system',
        updatedBy: 'system',
      },
    ];

    for (const planData of defaultPlans) {
      try {
        const existing = await planRepo.findOne({
          where: { name: planData.name },
        });

        if (!existing) {
          const plan = planRepo.create(planData);
          await planRepo.save(plan);
          this.logger.log(`Seeded plan: "${planData.name}" (${planData.tier})`);
        } else {
          this.logger.debug(
            `Plan "${planData.name}" already exists (id: ${existing.id}), skipping seed`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `Failed to seed plan "${planData.name}": ${
            error instanceof Error ? error.message : 'Unknown error'
          }`,
        );
      }
    }
  }
}
