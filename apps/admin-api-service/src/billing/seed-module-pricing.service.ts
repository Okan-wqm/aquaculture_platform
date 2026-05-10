import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { ModulePricing, type PricingMetric } from './entities/module-pricing.entity';
import { PricingMetricType } from './entities/pricing-metric.enum';

/**
 * SeedModulePricingService
 * ============================================================================
 *
 * Architectural replacement for `infrastructure/docker/init-scripts/05-seed-
 * module-pricing.sql`. The previous init-script seeded `admin.module_pricing`
 * directly via psql, but that pattern was strictly worse:
 *
 *   1. The script ran BEFORE auth-service's SeedService populated
 *      `auth.modules`. Without the module rows, the lookups
 *      `SELECT id FROM auth.modules WHERE code = 'farm'` returned NULL and
 *      the seed quietly skipped — operators only noticed when the SUPER
 *      ADMIN UI rendered "no pricing configured" for every module.
 *   2. Init scripts run as the postgres-superuser, with no NestJS context,
 *      no logger, no metrics, no idempotency tracking. A failure was a
 *      silent NOTICE in the postgres logs — never surfaced to the service.
 *   3. The SQL diverged from the entity definition; any column rename in
 *      `module-pricing.entity.ts` had to be mirrored manually in two SQL
 *      strings (the seed and the table-create script).
 *
 * # What this service does
 *
 *   - Runs `OnModuleInit` after admin-api-service finishes module wiring.
 *   - For each of the three core modules (farm, hr, sensor), looks up the
 *     module UUID from `auth.modules` (cross-schema read — admin-service
 *     role has SELECT on auth schema per `00-init-schemas.sh`).
 *   - Inserts the canonical pricing row into `admin.module_pricing` IFF
 *     the module exists in `auth.modules` AND no active pricing row
 *     already exists for that moduleCode.
 *
 * # Idempotency
 *
 *   - `findOne` existence check before INSERT — re-running on a seeded
 *     environment is a no-op.
 *   - Cross-schema lookup of `auth.modules.id` falls back gracefully when
 *     auth-service's seed has not yet completed: missing module → log
 *     warning, skip seed for that code, continue with the others.
 *
 * # Failure mode is non-fatal
 *
 * Same contract as `apps/auth-service/src/database/seed.service.ts`:
 * a seed failure must NOT crash the service. Operators fix the config
 * (or wait for auth-service to seed its modules) and restart to retry.
 * The platform must serve admin-api requests regardless of seed outcome.
 *
 * Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-055
 */
@Injectable()
export class SeedModulePricingService implements OnModuleInit {
  private readonly logger = new Logger(SeedModulePricingService.name);

  /**
   * Default pricing payloads — mirror the JSON literals previously embedded
   * in `05-seed-module-pricing.sql`. Kept as typed constants so any future
   * pricing-metric rename in the entity surface (or the
   * `PricingMetricType` enum) becomes a compile-time error here, not a
   * silent runtime drift.
   */
  private static readonly DEFAULT_PRICING: ReadonlyArray<{
    moduleCode: string;
    pricingMetrics: ReadonlyArray<PricingMetric>;
  }> = [
    {
      moduleCode: 'farm',
      pricingMetrics: [
        { type: PricingMetricType.BASE_PRICE, price: 50, currency: 'USD', description: 'Base monthly fee for Farm Management module' },
        { type: PricingMetricType.PER_USER, price: 10, currency: 'USD', description: 'Per active user', minQuantity: 1, includedQuantity: 2 },
        { type: PricingMetricType.PER_FARM, price: 25, currency: 'USD', description: 'Per farm/site', minQuantity: 1, includedQuantity: 1 },
        { type: PricingMetricType.PER_POND, price: 5, currency: 'USD', description: 'Per pond/tank', includedQuantity: 10 },
        { type: PricingMetricType.PER_REPORT, price: 0.5, currency: 'USD', description: 'Per generated analytics report', includedQuantity: 50 },
      ],
    },
    {
      moduleCode: 'hr',
      pricingMetrics: [
        { type: PricingMetricType.BASE_PRICE, price: 40, currency: 'USD', description: 'Base monthly fee for HR Management' },
        { type: PricingMetricType.PER_USER, price: 8, currency: 'USD', description: 'Per employee managed', includedQuantity: 10 },
        { type: PricingMetricType.PER_REPORT, price: 0.25, currency: 'USD', description: 'Per HR analytics report', includedQuantity: 30 },
      ],
    },
    {
      moduleCode: 'sensor',
      pricingMetrics: [
        { type: PricingMetricType.BASE_PRICE, price: 75, currency: 'USD', description: 'Base monthly fee for Sensor Monitoring module' },
        { type: PricingMetricType.PER_USER, price: 10, currency: 'USD', description: 'Per active user', minQuantity: 1, includedQuantity: 2 },
        { type: PricingMetricType.PER_SENSOR, price: 2, currency: 'USD', description: 'Per connected sensor', includedQuantity: 10 },
        { type: PricingMetricType.PER_DEVICE, price: 5, currency: 'USD', description: 'Per IoT gateway device', includedQuantity: 2 },
        { type: PricingMetricType.PER_GB_STORAGE, price: 0.5, currency: 'USD', description: 'Per GB of sensor data storage (TimescaleDB)', includedQuantity: 10 },
        { type: PricingMetricType.PER_ALERT, price: 0.02, currency: 'USD', description: 'Per alert triggered', includedQuantity: 1000 },
        { type: PricingMetricType.PER_REPORT, price: 0.5, currency: 'USD', description: 'Per sensor analytics report', includedQuantity: 30 },
      ],
    },
  ];

  /**
   * Tier multipliers replicate the literal previously embedded in the SQL
   * seed: starter pays full price, professional gets 10% off, enterprise
   * and custom both 30% off.
   */
  private static readonly DEFAULT_TIER_MULTIPLIERS = {
    starter: 1.0,
    professional: 0.9,
    enterprise: 0.7,
    custom: 0.7,
  } as const;

  constructor(
    @InjectRepository(ModulePricing)
    private readonly modulePricingRepository: Repository<ModulePricing>,
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seed();
  }

  async seed(): Promise<void> {
    this.logger.log('Starting admin.module_pricing seed...');

    try {
      let seeded = 0;
      let skipped = 0;
      for (const entry of SeedModulePricingService.DEFAULT_PRICING) {
        const did = await this.seedOne(entry.moduleCode, entry.pricingMetrics);
        if (did) {
          seeded++;
        } else {
          skipped++;
        }
      }
      this.logger.log(
        `Module pricing seed complete: ${seeded} inserted, ${skipped} already-present-or-skipped`,
      );
    } catch (error) {
      // Seed failures must NOT crash the service — operators correct
      // configuration and restart to retry. Mirror the auth-service
      // SeedService non-fatal contract.
      this.logger.error(
        `Module pricing seed failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Seed pricing for a single module. Returns `true` when an insert
   * occurred, `false` when the row was already present or the source
   * `auth.modules` row was missing (auth-service seed not yet run).
   */
  private async seedOne(
    moduleCode: string,
    pricingMetrics: ReadonlyArray<PricingMetric>,
  ): Promise<boolean> {
    // Cross-schema read — admin-service has SELECT on auth.* per the
    // GRANT block in 00-init-schemas.sh. We use parameterised query
    // (not template strings) for defense in depth even though
    // `moduleCode` is a hard-coded literal here.
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM auth.modules WHERE code = $1 LIMIT 1`,
      [moduleCode],
    );
    if (rows.length === 0) {
      this.logger.warn(
        `auth.modules has no row for code='${moduleCode}' — skipping pricing seed. ` +
          `auth-service's SeedService has likely not yet run; restart admin-api after ` +
          `auth-service has completed its module seed.`,
      );
      return false;
    }
    const moduleId = rows[0]!.id;

    const existing = await this.modulePricingRepository.findOne({
      where: { moduleCode, isActive: true },
    });
    if (existing) {
      this.logger.log(`module_pricing already present for code='${moduleCode}', skipping`);
      return false;
    }

    const row = this.modulePricingRepository.create({
      moduleId,
      moduleCode,
      pricingMetrics: [...pricingMetrics],
      tierMultipliers: { ...SeedModulePricingService.DEFAULT_TIER_MULTIPLIERS },
      currency: 'USD',
      isActive: true,
      notes: 'Default pricing from system seed',
      version: 1,
    });
    await this.modulePricingRepository.save(row);
    this.logger.log(`Seeded module_pricing for code='${moduleCode}'`);
    return true;
  }
}
