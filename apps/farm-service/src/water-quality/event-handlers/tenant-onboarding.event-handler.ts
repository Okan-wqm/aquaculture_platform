/**
 * TenantOnboardingEventHandler
 *
 * Subscribes to `TenantCreated` events published by admin-api-
 * service / tenant-service and runs every registered
 * per-tenant seeder so a freshly-provisioned tenant has a
 * working default data set. Closes the phase-6.5 strict-mode
 * onboarding gap (new tenants failing the first water-quality
 * measurement because no parameter configs exist) and expands
 * it to the species catalogue that batch creation needs.
 *
 * Phase 7.5 of the "Farm modülü kalan kör noktalar" plan.
 *
 * # Which seeders run today?
 *
 *   1. `WaterQualityParameterConfigSeederService` — the FAO /
 *      Mattilsynet salmonid starter set (temp / pH / DO /
 *      ammonia / nitrite / salinity / turbidity).
 *   2. `SpeciesSeederService` — Atlantic Salmon + the two
 *      cleaner-fish species (Lumpfish + Ballan Wrasse).
 *
 * Future phase-7.5.* PRs add:
 *   - equipment-types seeder (global table, no per-tenant
 *     row; just a sanity check that the global catalog is
 *     reachable)
 *   - feeding-protocols seeder (per-species, per-life-stage)
 *   - regulatory-settings seeder (country-aware)
 *
 * # Per-seeder fault tolerance
 *
 * Each seeder runs inside its own try/catch. A failure in
 * ONE seeder does NOT block the others — a tenant with a
 * partial onboarding is degraded but usable, and the operator
 * can retry any failed seeder via its dedicated admin
 * mutation. Fail-closed atomicity (all-or-nothing onboarding)
 * is the wrong posture here because the seeders write to
 * unrelated tables; a species failure shouldn't roll back
 * the WQ configs that were already committed.
 *
 * # Defensive validation
 *
 *   - Missing / malformed tenantId → log error, skip all
 *     seeders (prevents cross-tenant writes if the publisher
 *     misbehaves)
 *   - EventBus unavailable → subscription no-ops, log warning
 *     (dev harnesses without NATS still boot)
 */
import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import type { TenantCreatedEvent } from '@platform/event-contracts';

import { WaterQualityParameterConfigSeederService } from '../services/water-quality-parameter-config-seeder.service';
import { SpeciesSeederService } from '../../species/services/species-seeder.service';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SeederSummary {
  name: string;
  ok: boolean;
  seeded: number;
  skipped: number;
  error?: string;
}

@Injectable()
export class TenantOnboardingEventHandler
  implements IEventHandler<TenantCreatedEvent>, OnModuleInit
{
  private readonly logger = new Logger(TenantOnboardingEventHandler.name);

  constructor(
    private readonly wqSeeder: WaterQualityParameterConfigSeederService,
    private readonly speciesSeeder: SpeciesSeederService,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn(
        'EVENT_BUS not available — TenantCreated subscription skipped. ' +
          'Newly-provisioned tenants will need to run the seeder mutations ' +
          'manually from the admin UI.',
      );
      return;
    }
    await this.eventBus.subscribeWildcard('TenantCreated', this);
    this.logger.log(
      'Subscribed to TenantCreated events for automatic tenant onboarding ' +
        '(water-quality parameter configs + species catalogue)',
    );
  }

  getEventType(): string {
    return 'TenantCreated';
  }

  async handle(event: TenantCreatedEvent): Promise<void> {
    if (!event.tenantId || !UUID_REGEX.test(event.tenantId)) {
      this.logger.error(
        `TenantCreated event has invalid or missing tenantId ` +
          `(got '${event.tenantId}'). Skipping onboarding to prevent ` +
          'cross-tenant writes.',
      );
      return;
    }

    const summaries: SeederSummary[] = [];

    // Water-quality parameter configs — closes the phase-6.5
    // strict-mode gap (first WQ measurement must not 400).
    summaries.push(
      await this.runSeeder('water-quality-parameters', () =>
        this.wqSeeder.seedDefaults(event.tenantId),
      ),
    );

    // Species catalogue — Atlantic Salmon + cleaner fish. Batch
    // creation needs at least one active species to link against.
    summaries.push(
      await this.runSeeder('species', () =>
        this.speciesSeeder.seedDefaults(event.tenantId),
      ),
    );

    const ok = summaries.filter((s) => s.ok);
    const failed = summaries.filter((s) => !s.ok);
    const totalSeeded = summaries.reduce((acc, s) => acc + s.seeded, 0);
    const totalSkipped = summaries.reduce((acc, s) => acc + s.skipped, 0);

    this.logger.log(
      `Onboarded tenant ${event.tenantId.slice(0, 8)}... ` +
        `(${event.name ?? 'unnamed'}): ` +
        `${ok.length}/${summaries.length} seeders ok, ` +
        `${totalSeeded} rows created, ${totalSkipped} skipped` +
        (failed.length
          ? ` — failed: ${failed.map((f) => f.name).join(', ')}`
          : ''),
    );
  }

  /**
   * Run a single seeder and capture the outcome. Never throws —
   * the handler returns a structured summary so the log line can
   * report the full picture even when one seeder errored.
   */
  private async runSeeder(
    name: string,
    run: () => Promise<{ seeded: string[]; skipped: string[] }>,
  ): Promise<SeederSummary> {
    try {
      const result = await run();
      return {
        name,
        ok: true,
        seeded: result.seeded.length,
        skipped: result.skipped.length,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Seeder '${name}' failed during onboarding: ${message}. ` +
          'Operator can retry via the admin mutation; siblings continue.',
        err instanceof Error ? err.stack : undefined,
      );
      return { name, ok: false, seeded: 0, skipped: 0, error: message };
    }
  }
}
