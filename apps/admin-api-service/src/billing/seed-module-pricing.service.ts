import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { ModulePricingService } from './services/module-pricing.service';

/**
 * SeedModulePricingService
 * ============================================================================
 *
 * Publishes the default price sheet for the core modules at boot, for a fresh
 * environment that has none.
 *
 * # Why admin still starts this (ADR-0013)
 *
 * billing owns the sheet and the default template — `DEFAULT_MODULE_PRICES` in
 * `apps/billing-service/src/billing/services/default-module-prices.ts` — but
 * the module a sheet prices is a row in `auth.modules`, and only admin-api
 * holds a grant on that schema. So admin resolves the code → id mapping and
 * billing publishes the sheets, over
 * `request.billing.admin.seedModulePrices`.
 *
 * This service used to carry a fifth copy of the price table (after the entity
 * defaults, the admin `data/` module, the SQL init script it replaced, and the
 * quote calculator) and INSERT into `admin.module_pricing` directly. Both are
 * gone: there is one template, in the service that owns the rows.
 *
 * # Ordering
 *
 * `OnModuleInit` runs after admin-api finishes wiring. `auth.modules` may not
 * be seeded yet on a very first boot — `seedDefaultPricing` resolves what
 * exists and returns 0 for the rest, and the next restart picks them up.
 * Idempotent: billing skips any module that already has a sheet in force.
 *
 * # Failure contract
 *
 * A seed failure must NOT crash the service — operators correct configuration
 * and restart to retry, mirroring the auth-service SeedService contract.
 */
@Injectable()
export class SeedModulePricingService implements OnModuleInit {
  private readonly logger = new Logger(SeedModulePricingService.name);

  /** The core modules a fresh environment ships with. */
  private static readonly SEEDED_MODULE_CODES = ['farm', 'hr', 'sensor'] as const;

  /** Boot-time seeding is the platform acting, not a person. */
  private static readonly SYSTEM_ACTOR = 'admin-api:seed-module-pricing';

  constructor(private readonly modulePricing: ModulePricingService) {}

  async onModuleInit(): Promise<void> {
    await this.seed();
  }

  async seed(): Promise<void> {
    try {
      const seeded = await this.modulePricing.seedDefaultPricing(
        [...SeedModulePricingService.SEEDED_MODULE_CODES],
        SeedModulePricingService.SYSTEM_ACTOR,
      );
      this.logger.log(
        JSON.stringify({
          event: 'module-price.seed.complete',
          seeded,
          requested: SeedModulePricingService.SEEDED_MODULE_CODES.length,
        }),
      );
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'module-price.seed.failed',
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}
