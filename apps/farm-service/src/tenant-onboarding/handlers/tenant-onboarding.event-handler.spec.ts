import { Test } from '@nestjs/testing';
import { createBaseEvent, type TenantOnboardingRequestedEvent } from '@platform/event-contracts';

import { EquipmentTypeCatalogCheckerService } from '../../equipment/services/equipment-type-catalog-checker.service';
import { FeedingProtocolSeederService } from '../../feed/services/feeding-protocol-seeder.service';
import { FinanceCategorySeedService } from '../../finance/services/finance-category-seed.service';
import { RegulatorySettingsSeederService } from '../../regulatory/services/regulatory-settings-seeder.service';
import { SpeciesSeederService } from '../../species/services/species-seeder.service';
import { WaterQualityParameterConfigSeederService } from '../../water-quality/services/water-quality-parameter-config-seeder.service';
import { TenantOnboardingReceiptState } from '../entities/tenant-onboarding-receipt.entity';
import { TenantOnboardingReceiptService } from '../services/tenant-onboarding-receipt.service';
import { TenantOnboardingEventHandler } from './tenant-onboarding.event-handler';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function event(): TenantOnboardingRequestedEvent {
  return {
    ...createBaseEvent<TenantOnboardingRequestedEvent>('TenantOnboardingRequested', TENANT_ID, {
      aggregateId: TENANT_ID,
      aggregateType: 'Tenant',
    }),
    operationId: '22222222-2222-4222-8222-222222222222',
    attempt: 1,
    requestHash: 'a'.repeat(64),
    name: 'Acme Aqua',
    slug: 'acme-aqua',
    moduleIds: ['33333333-3333-4333-8333-333333333333'],
  };
}

describe('TenantOnboardingEventHandler', () => {
  const build = async (
    claim: jest.Mock,
    complete = jest.fn().mockResolvedValue(undefined),
    species = jest.fn().mockResolvedValue({ seeded: ['salmon'], skipped: [] }),
  ) => {
    const seedDefaults = jest.fn().mockResolvedValue({ seeded: [], skipped: [] });
    const subscribeWildcard = jest.fn().mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        TenantOnboardingEventHandler,
        { provide: WaterQualityParameterConfigSeederService, useValue: { seedDefaults } },
        { provide: SpeciesSeederService, useValue: { seedDefaults: species } },
        { provide: FeedingProtocolSeederService, useValue: { seedDefaults } },
        { provide: RegulatorySettingsSeederService, useValue: { seedDefaults } },
        { provide: EquipmentTypeCatalogCheckerService, useValue: { seedDefaults } },
        { provide: FinanceCategorySeedService, useValue: { seedDefaults } },
        { provide: TenantOnboardingReceiptService, useValue: { claim, complete } },
        { provide: 'EVENT_BUS', useValue: { subscribeWildcard } },
      ],
    }).compile();
    return {
      handler: moduleRef.get(TenantOnboardingEventHandler),
      complete,
      species,
      seedDefaults,
      subscribeWildcard,
    };
  };

  it('registers the catalogued durable consumer revision at boot', async () => {
    const harness = await build(jest.fn());
    await harness.handler.onModuleInit();

    expect(harness.subscribeWildcard).toHaveBeenCalledWith(
      'TenantOnboardingRequested',
      harness.handler,
      expect.objectContaining({
        durable: true,
        consumerVersion: 'tenant-onboarding-v1',
        startFrom: 'beginning',
      }),
    );
  });

  it('does not rerun seeders for a terminal command redelivery', async () => {
    const claim = jest.fn().mockResolvedValue({
      kind: 'terminal-replay',
      receiptId: '44444444-4444-4444-8444-444444444444',
      state: TenantOnboardingReceiptState.ACKNOWLEDGED,
    });
    const harness = await build(claim);

    await harness.handler.handle(event());

    expect(harness.species).not.toHaveBeenCalled();
    expect(harness.seedDefaults).not.toHaveBeenCalled();
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it('records every seeder outcome before completing the durable receipt', async () => {
    const claim = jest.fn().mockResolvedValue({
      kind: 'claimed',
      receiptId: '44444444-4444-4444-8444-444444444444',
      leaseToken: '55555555-5555-4555-8555-555555555555',
    });
    const species = jest.fn().mockRejectedValue(new Error('species seed failed'));
    const harness = await build(claim, jest.fn().mockResolvedValue(undefined), species);
    const request = event();

    await harness.handler.handle(request);

    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.complete.mock.calls[0]?.[0]).toBe(request);
    expect(harness.complete.mock.calls[0]?.[2]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'species',
          ok: false,
          error: 'species seed failed',
        }),
      ]),
    );
  });
});
