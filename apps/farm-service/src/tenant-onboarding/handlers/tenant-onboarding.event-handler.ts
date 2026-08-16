import { withTenantContext } from '@aquaculture/backend-common/context';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import {
  TENANT_ONBOARDING_WORKFLOW_V1,
  type TenantOnboardingRequestedEvent,
} from '@platform/event-contracts';

import { EquipmentTypeCatalogCheckerService } from '../../equipment/services/equipment-type-catalog-checker.service';
import { FeedingProtocolSeederService } from '../../feed/services/feeding-protocol-seeder.service';
import { FinanceCategorySeedService } from '../../finance/services/finance-category-seed.service';
import { RegulatorySettingsSeederService } from '../../regulatory/services/regulatory-settings-seeder.service';
import { SpeciesSeederService } from '../../species/services/species-seeder.service';
import { WaterQualityParameterConfigSeederService } from '../../water-quality/services/water-quality-parameter-config-seeder.service';
import {
  TenantOnboardingReceiptService,
  type TenantOnboardingSeederEvidence,
} from '../services/tenant-onboarding-receipt.service';

@Injectable()
export class TenantOnboardingEventHandler
  implements IEventHandler<TenantOnboardingRequestedEvent>, OnModuleInit
{
  private readonly logger = new Logger(TenantOnboardingEventHandler.name);

  constructor(
    private readonly wqSeeder: WaterQualityParameterConfigSeederService,
    private readonly speciesSeeder: SpeciesSeederService,
    private readonly feedingProtocolSeeder: FeedingProtocolSeederService,
    private readonly regulatorySettingsSeeder: RegulatorySettingsSeederService,
    private readonly equipmentTypeChecker: EquipmentTypeCatalogCheckerService,
    private readonly financeCategorySeeder: FinanceCategorySeedService,
    private readonly receipts: TenantOnboardingReceiptService,
    @Inject('EVENT_BUS') private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    const subscription = TENANT_ONBOARDING_WORKFLOW_V1.subscription;
    await this.eventBus.subscribeWildcard(TENANT_ONBOARDING_WORKFLOW_V1.request.eventType, this, {
      durable: true,
      consumerVersion: subscription.consumerVersion,
      startFrom: subscription.startFrom,
      ackWait: subscription.ackWaitSeconds,
      maxRetries: subscription.maxDeliveries,
    });
  }

  getEventType(): string {
    return TENANT_ONBOARDING_WORKFLOW_V1.request.eventType;
  }

  async handle(event: TenantOnboardingRequestedEvent): Promise<void> {
    const claim = await this.receipts.claim(event);
    if (claim.kind === 'terminal-replay') {
      this.logger.log(
        `Tenant onboarding replay resolved from durable receipt ${claim.receiptId} (${claim.state})`,
      );
      return;
    }

    const summaries: TenantOnboardingSeederEvidence[] = [];
    await withTenantContext(event.tenantId, async () => {
      summaries.push(
        await this.runSeeder('water-quality-parameters', () =>
          this.wqSeeder.seedDefaults(event.tenantId),
        ),
        await this.runSeeder('species', () => this.speciesSeeder.seedDefaults(event.tenantId)),
        await this.runSeeder('feeding-protocols', () =>
          this.feedingProtocolSeeder.seedDefaults(event.tenantId),
        ),
        await this.runSeeder('regulatory-settings', () =>
          this.regulatorySettingsSeeder.seedDefaults(event.tenantId),
        ),
        await this.runSeeder('equipment-types-global', () =>
          this.equipmentTypeChecker.seedDefaults(event.tenantId),
        ),
        await this.runSeeder('finance-categories', () =>
          this.financeCategorySeeder.seedDefaults(event.tenantId),
        ),
      );
    });

    await this.receipts.complete(event, claim, summaries);
  }

  private async runSeeder(
    name: string,
    run: () => Promise<{ seeded: string[]; skipped: string[] }>,
  ): Promise<TenantOnboardingSeederEvidence> {
    try {
      const result = await run();
      return {
        name,
        ok: true,
        seeded: result.seeded.length,
        skipped: result.skipped.length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Tenant onboarding seeder ${name} failed: ${message}`);
      return { name, ok: false, seeded: 0, skipped: 0, error: message };
    }
  }
}
