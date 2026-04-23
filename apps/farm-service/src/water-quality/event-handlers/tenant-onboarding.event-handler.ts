/**
 * TenantOnboardingEventHandler
 *
 * Subscribes to `TenantCreated` events published by admin-api-
 * service / tenant-service and seeds the default
 * water-quality parameter catalogue for the freshly-provisioned
 * tenant. Closes the phase-6.5 strict-mode onboarding gap at the
 * event layer: new tenants automatically have a working config
 * set, so the first water-quality measurement does not 400 with
 * NO_ACTIVE_PARAMETER_CONFIGS.
 *
 * The handler is deliberately narrow — only the WQ seeder runs
 * today. When equipment-types / species / feeding-protocols /
 * regulatory-settings seeders land (phase 7.5.1 / 7.5.2 etc.)
 * each gets added to the same handler so the onboarding
 * payload fans out from a single event.
 *
 * Fault tolerance:
 *   - Missing tenantId on the event → log + skip (defensive —
 *     the publisher normally enforces it, but we guard anyway)
 *   - Seeder error → log + continue (a tenant without seeded
 *     configs is degraded, not broken; operators can re-run the
 *     `seedDefaultWaterQualityParameterConfigs` mutation)
 *   - EventBus unavailable → subscription no-ops, log warning
 *
 * Phase 7.5 of the "Farm modülü kalan kör noktalar" plan.
 * Closes Girdi 15-C7.
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

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class TenantOnboardingEventHandler
  implements IEventHandler<TenantCreatedEvent>, OnModuleInit
{
  private readonly logger = new Logger(TenantOnboardingEventHandler.name);

  constructor(
    private readonly wqSeeder: WaterQualityParameterConfigSeederService,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn(
        'EVENT_BUS not available — TenantCreated subscription skipped. ' +
          'Newly-provisioned tenants will need to run ' +
          'seedDefaultWaterQualityParameterConfigs manually.',
      );
      return;
    }
    await this.eventBus.subscribeWildcard('TenantCreated', this);
    this.logger.log(
      'Subscribed to TenantCreated events for automatic WQ parameter seeding',
    );
  }

  getEventType(): string {
    return 'TenantCreated';
  }

  async handle(event: TenantCreatedEvent): Promise<void> {
    if (!event.tenantId || !UUID_REGEX.test(event.tenantId)) {
      this.logger.error(
        `TenantCreated event has invalid or missing tenantId (got '${event.tenantId}'). ` +
          'Skipping onboarding seed to prevent cross-tenant writes.',
      );
      return;
    }

    try {
      const result = await this.wqSeeder.seedDefaults(event.tenantId);
      this.logger.log(
        `Onboarded tenant ${event.tenantId.slice(0, 8)}... (${event.name ?? 'unnamed'}): ` +
          `WQ seeder created ${result.seeded.length} configs, skipped ${result.skipped.length}`,
      );
    } catch (err) {
      this.logger.error(
        `WQ parameter seed failed during onboarding for tenant ` +
          `${event.tenantId.slice(0, 8)}...: ${(err as Error).message}. ` +
          'Operator can retry via seedDefaultWaterQualityParameterConfigs mutation.',
        err instanceof Error ? err.stack : undefined,
      );
    }
  }
}
