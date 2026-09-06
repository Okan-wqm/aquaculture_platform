/**
 * TenantOnboardingEventHandler
 *
 * Subscribes to `TenantOnboardingRequested` events published by admin-api-
 * service and runs every registered
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
 *   3. `FeedingProtocolSeederService` — Atlantic-salmon
 *      life-stage protocols (FRY / STARTER / GROWER / FINISHER).
 *   4. `RegulatorySettingsSeederService` — skeleton
 *      `regulatory_settings` row (Maskinporten env = TEST,
 *      credential columns left NULL for the tenant-admin to
 *      fill in) so biomass / mortality / Mattilsynet surfaces
 *      have a deterministic anchor row on first query.
 *   5. `EquipmentTypeCatalogCheckerService` — read-only sanity
 *      check on the GLOBAL `equipment_types` table. Never
 *      writes. Logs a loud WARN if the catalogue is empty
 *      (migration 007 didn't run) so operators catch
 *      deployment-health gaps before customers hit
 *      "no equipment type found" errors.
 *
 * Phase 7.5 onboarding seeders — COMPLETE. Further expansions
 * (country-aware defaults, hardware-specific seeds) arrive in
 * their own phases; the onboarding event handler stays open to
 * extension via this same seeder array pattern.
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
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { withTenantContext } from '@aquaculture/backend-common/context';
import { IEventBus, IEventHandler, HandlerOutcome } from '@platform/event-bus';
import {
  createBaseEvent,
  type TenantOnboardingFailedEvent,
  type TenantOnboardingRequestedEvent,
} from '@platform/event-contracts';

import { WaterQualityParameterConfigSeederService } from '../services/water-quality-parameter-config-seeder.service';
import { SpeciesSeederService } from '../../species/services/species-seeder.service';
import { FeedingProtocolSeederService } from '../../feed/services/feeding-protocol-seeder.service';
import { FeedingReadinessCheckerService } from '../../feeding-protocol/services/feeding-readiness-checker.service';
import { RegulatorySettingsSeederService } from '../../regulatory/services/regulatory-settings-seeder.service';
import { EquipmentTypeCatalogCheckerService } from '../../equipment/services/equipment-type-catalog-checker.service';
import { FinanceCategorySeedService } from '../../finance/services/finance-category-seed.service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SeederSummary {
  name: string;
  ok: boolean;
  seeded: number;
  skipped: number;
  error?: string;
}

@Injectable()
export class TenantOnboardingEventHandler
  implements IEventHandler<TenantOnboardingRequestedEvent>, OnModuleInit
{
  private readonly logger = new Logger(TenantOnboardingEventHandler.name);

  constructor(
    private readonly wqSeeder: WaterQualityParameterConfigSeederService,
    private readonly speciesSeeder: SpeciesSeederService,
    private readonly feedingProtocolSeeder: FeedingProtocolSeederService,
    private readonly feedingReadinessChecker: Pick<FeedingReadinessCheckerService, 'check'>,
    private readonly regulatorySettingsSeeder: RegulatorySettingsSeederService,
    private readonly equipmentTypeChecker: EquipmentTypeCatalogCheckerService,
    private readonly financeCategorySeeder: FinanceCategorySeedService,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus | undefined,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      throw new Error('EVENT_BUS is required for tenant onboarding ack/fail publication');
    }
    await this.eventBus.subscribeWildcard('TenantOnboardingRequested', this);
    this.logger.log(
      'Subscribed to TenantOnboardingRequested events for automatic tenant onboarding ' +
        '(water-quality configs + species catalogue + feeding protocols + ' +
        'regulatory settings + equipment-types catalogue check)',
    );
  }

  getEventType(): string {
    return 'TenantOnboardingRequested';
  }

  async handle(event: TenantOnboardingRequestedEvent): Promise<HandlerOutcome> {
    if (!event.tenantId || !UUID_REGEX.test(event.tenantId)) {
      this.logger.error(
        `TenantOnboardingRequested event has invalid or missing tenantId ` +
          `(got '${event.tenantId}'). Skipping onboarding to prevent ` +
          'cross-tenant writes.',
      );
      return HandlerOutcome.terminate('TenantOnboardingRequested: missing or invalid tenantId');
    }

    const summaries: SeederSummary[] = [];

    // Seeders write per-tenant data via @InjectRepository, which resolves the
    // tenant schema + RLS GUC from AsyncLocalStorage. A NATS event handler has
    // no HTTP request context, so without withTenantContext the seed writes
    // would land in the source `farm` schema (or be RLS-denied) instead of
    // tenant_<uuid>. Establish the tenant frame for the whole seeder run; the
    // ack/fail publish below stays OUTSIDE it (cross-tenant outbox infra).
    await withTenantContext(event.tenantId, async () => {
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
        await this.runSeeder('species', () => this.speciesSeeder.seedDefaults(event.tenantId)),
      );

      // Feeding protocols — life-stage protocols for Atlantic Salmon
      // (FRY → STARTER → GROWER → FINISHER). The feeding scheduler
      // picks the stage-matched protocol automatically on new batches.
      summaries.push(
        await this.runSeeder('feeding-protocols', () =>
          this.feedingProtocolSeeder.seedDefaults(event.tenantId),
        ),
      );

      // W8/FARM-MEDIUM-284 — v2 yemleme hazırlığı KONTROLÜ (satır yazmaz).
      // Yukarıdaki v1 protokol tohumlaması cutover'dan sonra motorun OKUMADIĞI
      // bir tabloyu doldurur; bu kontrol tenant'ın FİİLEN yemleyip
      // yemleyemeyeceğini (≥1 ACTIVE v2 protokol) ölçer ve boşluğu
      // provisioning anında yüksek sesle raporlar — ilk stoklamayı ve 06:00
      // UnfedUnitDetected'ı beklemeden.
      summaries.push(
        await this.runSeeder('feeding-readiness-v2', () =>
          this.feedingReadinessChecker.check(event.tenantId),
        ),
      );

      // Regulatory settings — skeleton row with Maskinporten env=TEST
      // and empty credentials. Ensures biomass / mortality / Mattilsynet
      // read-paths don't return null on first query for the new tenant.
      summaries.push(
        await this.runSeeder('regulatory-settings', () =>
          this.regulatorySettingsSeeder.seedDefaults(event.tenantId),
        ),
      );

      // Equipment-type catalogue sanity check — global (not per-tenant)
      // so the checker never writes rows. Logs a WARN if the global
      // catalogue is empty so deployment-health issues surface early
      // instead of at first customer equipment registration.
      summaries.push(
        await this.runSeeder('equipment-types-global', () =>
          this.equipmentTypeChecker.seedDefaults(event.tenantId),
        ),
      );

      // Finance category catalogue — the default farm OPEX/revenue
      // taxonomy (electricity, feed, oxygen, insurance, the 5% computed
      // rule, …) so the finance tab is populated on first open. Also
      // seeded lazily on first finance query for pre-existing tenants.
      summaries.push(
        await this.runSeeder('finance-categories', () =>
          this.financeCategorySeeder.seedDefaults(event.tenantId),
        ),
      );
    });

    const ok = summaries.filter((s) => s.ok);
    const failed = summaries.filter((s) => !s.ok);
    const totalSeeded = summaries.reduce((acc, s) => acc + s.seeded, 0);
    const totalSkipped = summaries.reduce((acc, s) => acc + s.skipped, 0);

    this.logger.log(
      `Onboarded tenant ${event.tenantId.slice(0, 8)}... ` +
        `(${event.name ?? 'unnamed'}): ` +
        `${ok.length}/${summaries.length} seeders ok, ` +
        `${totalSeeded} rows created, ${totalSkipped} skipped` +
        (failed.length ? ` — failed: ${failed.map((f) => f.name).join(', ')}` : ''),
    );

    const eventBus = this.eventBus;
    if (!eventBus) {
      throw new Error('EVENT_BUS is required for tenant onboarding ack/fail publication');
    }

    if (failed.length > 0) {
      await eventBus.publish({
        ...createBaseEvent<TenantOnboardingFailedEvent>('TenantOnboardingFailed', event.tenantId, {
          aggregateId: event.tenantId,
          aggregateType: 'Tenant',
        }),
        operationId: event.operationId,
        service: 'farm-service',
        error: failed.map((f) => `${f.name}: ${f.error ?? 'failed'}`).join('; '),
      });
      // The failure is reported to the saga (TenantOnboardingFailed) and the
      // operator retries through the admin mutation — the trigger itself is
      // consumed.
      return HandlerOutcome.ack();
    }

    await eventBus.publish({
      ...createBaseEvent('TenantOnboardingAck', event.tenantId, {
        aggregateId: event.tenantId,
        aggregateType: 'Tenant',
      }),
      operationId: event.operationId,
      service: 'farm-service',
      acknowledgedAt: new Date().toISOString(),
    });
    return HandlerOutcome.ack();
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
