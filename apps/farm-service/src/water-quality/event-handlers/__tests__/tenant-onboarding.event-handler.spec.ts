/**
 * TenantOnboardingEventHandler Unit Tests
 *
 * Exercises:
 *   - valid TenantOnboardingRequested event → EVERY seeder runs with tenantId
 *   - invalid tenantId format → no seeder called
 *   - missing tenantId → no seeder called
 *   - one seeder error → siblings still run and failure is published
 *   - all seeders erroring → handler resolves and failure is published
 *   - EventBus absent (onModuleInit) → fail closed
 *   - getEventType returns 'TenantOnboardingRequested'
 */
import { getRequestContext } from '@aquaculture/backend-common/logging';

import { TenantOnboardingEventHandler } from '../tenant-onboarding.event-handler';
import { WaterQualityParameterConfigSeederService } from '../../services/water-quality-parameter-config-seeder.service';
import { SpeciesSeederService } from '../../../species/services/species-seeder.service';
import { FeedingProtocolSeederService } from '../../../feed/services/feeding-protocol-seeder.service';
import { RegulatorySettingsSeederService } from '../../../regulatory/services/regulatory-settings-seeder.service';
import { EquipmentTypeCatalogCheckerService } from '../../../equipment/services/equipment-type-catalog-checker.service';
import { FinanceCategorySeedService } from '../../../finance/services/finance-category-seed.service';
import type {
  TenantOnboardingAckEvent,
  TenantOnboardingFailedEvent,
  TenantOnboardingRequestedEvent,
} from '@platform/event-contracts';

interface SeederDouble {
  seedDefaults: jest.Mock;
}

/**
 * Narrow a SeederDouble to the finance seeder's public surface via a
 * typed Partial (the handler only calls seedDefaults).
 */
function financeSeederDouble(double: SeederDouble): FinanceCategorySeedService {
  const partial: Partial<FinanceCategorySeedService> = {
    seedDefaults: double.seedDefaults,
  };
  return partial as FinanceCategorySeedService;
}

interface BusDouble {
  subscribeWildcard: jest.Mock;
  publish: jest.Mock<Promise<void>, [TenantOnboardingAckEvent | TenantOnboardingFailedEvent]>;
}

function makeHandler(opts: {
  wqResult?: { seeded: string[]; skipped: string[] };
  wqError?: Error;
  speciesResult?: { seeded: string[]; skipped: string[] };
  speciesError?: Error;
  protocolResult?: { seeded: string[]; skipped: string[] };
  protocolError?: Error;
  regulatoryResult?: { seeded: string[]; skipped: string[] };
  regulatoryError?: Error;
  equipmentResult?: { seeded: string[]; skipped: string[] };
  equipmentError?: Error;
  eventBus?: BusDouble;
}): {
  handler: TenantOnboardingEventHandler;
  wq: SeederDouble;
  species: SeederDouble;
  protocol: SeederDouble;
  regulatory: SeederDouble;
  equipment: SeederDouble;
  finance: SeederDouble;
  bus?: BusDouble;
} {
  const wq: SeederDouble = {
    seedDefaults: jest.fn().mockImplementation(async () => {
      if (opts.wqError) throw opts.wqError;
      return opts.wqResult ?? { seeded: ['temperature', 'ph'], skipped: [] };
    }),
  };
  const species: SeederDouble = {
    seedDefaults: jest.fn().mockImplementation(async () => {
      if (opts.speciesError) throw opts.speciesError;
      return opts.speciesResult ?? { seeded: ['ATLANTIC_SALMON'], skipped: [] };
    }),
  };
  const protocol: SeederDouble = {
    seedDefaults: jest.fn().mockImplementation(async () => {
      if (opts.protocolError) throw opts.protocolError;
      return (
        opts.protocolResult ?? {
          seeded: ['ATLANTIC_SALMON:grower'],
          skipped: [],
        }
      );
    }),
  };
  const regulatory: SeederDouble = {
    seedDefaults: jest.fn().mockImplementation(async () => {
      if (opts.regulatoryError) throw opts.regulatoryError;
      return (
        opts.regulatoryResult ?? {
          seeded: ['regulatory-settings'],
          skipped: [],
        }
      );
    }),
  };
  const equipment: SeederDouble = {
    seedDefaults: jest.fn().mockImplementation(async () => {
      if (opts.equipmentError) throw opts.equipmentError;
      return (
        opts.equipmentResult ?? {
          seeded: [],
          skipped: ['equipment-types-global'],
        }
      );
    }),
  };
  const finance: SeederDouble = {
    seedDefaults: jest.fn().mockImplementation(async () => ({
      seeded: ['FEED', 'ELECTRICITY'],
      skipped: [],
    })),
  };
  const defaultEventBus: BusDouble = {
    subscribeWildcard: jest.fn().mockResolvedValue(undefined),
    publish: jest
      .fn<Promise<void>, [TenantOnboardingAckEvent | TenantOnboardingFailedEvent]>()
      .mockResolvedValue(undefined),
  };
  const eventBus = Object.prototype.hasOwnProperty.call(opts, 'eventBus')
    ? opts.eventBus
    : defaultEventBus;
  const handler = new TenantOnboardingEventHandler(
    wq as unknown as WaterQualityParameterConfigSeederService,
    species as unknown as SpeciesSeederService,
    protocol as unknown as FeedingProtocolSeederService,
    regulatory as unknown as RegulatorySettingsSeederService,
    equipment as unknown as EquipmentTypeCatalogCheckerService,
    financeSeederDouble(finance),
    eventBus as never,
  );
  (handler as unknown as { eventBus?: BusDouble }).eventBus = eventBus;
  return { handler, wq, species, protocol, regulatory, equipment, finance, bus: eventBus };
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const OPERATION = '22222222-2222-4222-8222-222222222222';
const MODULES = ['farm-core'];

describe('TenantOnboardingEventHandler', () => {
  it('returns the correct event type', () => {
    const { handler } = makeHandler({});
    expect(handler.getEventType()).toBe('TenantOnboardingRequested');
  });

  it('runs every seeder on a valid TenantOnboardingRequested event', async () => {
    const { handler, wq, species, protocol, regulatory, equipment, bus } = makeHandler({});
    await handler.handle({
      eventType: 'TenantOnboardingRequested',
      tenantId: TENANT,
      operationId: OPERATION,
      generation: 1,
      name: 'Acme Salmon Farms',
      slug: 'acme',
      moduleIds: MODULES,
    } as TenantOnboardingRequestedEvent);
    expect(wq.seedDefaults).toHaveBeenCalledWith(TENANT);
    expect(species.seedDefaults).toHaveBeenCalledWith(TENANT);
    expect(protocol.seedDefaults).toHaveBeenCalledWith(TENANT);
    expect(regulatory.seedDefaults).toHaveBeenCalledWith(TENANT);
    expect(equipment.seedDefaults).toHaveBeenCalledWith(TENANT);
    expect(bus?.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'TenantOnboardingAck',
        tenantId: TENANT,
        operationId: OPERATION,
        generation: 1,
        service: 'farm-service',
      }),
    );
  });

  it('runs the seeders inside a tenant context (withTenantContext frame established)', async () => {
    const { handler, wq } = makeHandler({});
    let capturedTenant: string | undefined;
    wq.seedDefaults.mockImplementation(async () => {
      // A NATS handler has no HTTP request context; this proves the handler
      // opened a withTenantContext frame so the seeder's repositories route to
      // the tenant schema instead of the source `farm` schema.
      capturedTenant = getRequestContext().tenantId;
      return { seeded: [], skipped: [] };
    });

    await handler.handle({
      eventType: 'TenantOnboardingRequested',
      tenantId: TENANT,
      operationId: OPERATION,
      generation: 1,
      name: 'Acme',
      slug: 'acme',
      moduleIds: MODULES,
    } as TenantOnboardingRequestedEvent);

    expect(capturedTenant).toBe(TENANT);
  });

  it('skips every seeder when tenantId format is invalid', async () => {
    const { handler, wq, species, protocol, regulatory, equipment } = makeHandler({});
    await handler.handle({
      eventType: 'TenantOnboardingRequested',
      tenantId: 'not-a-uuid',
      operationId: OPERATION,
      generation: 1,
      name: 'Malformed',
      slug: 'bad',
      moduleIds: MODULES,
    } as TenantOnboardingRequestedEvent);
    expect(wq.seedDefaults).not.toHaveBeenCalled();
    expect(species.seedDefaults).not.toHaveBeenCalled();
    expect(protocol.seedDefaults).not.toHaveBeenCalled();
    expect(regulatory.seedDefaults).not.toHaveBeenCalled();
    expect(equipment.seedDefaults).not.toHaveBeenCalled();
  });

  it('skips every seeder when tenantId is missing', async () => {
    const { handler, wq, species, protocol, regulatory, equipment } = makeHandler({});
    await handler.handle({
      eventType: 'TenantOnboardingRequested',
      operationId: OPERATION,
      generation: 1,
      name: 'Missing',
      slug: 'missing',
      moduleIds: MODULES,
    } as unknown as TenantOnboardingRequestedEvent);
    expect(wq.seedDefaults).not.toHaveBeenCalled();
    expect(species.seedDefaults).not.toHaveBeenCalled();
    expect(protocol.seedDefaults).not.toHaveBeenCalled();
    expect(regulatory.seedDefaults).not.toHaveBeenCalled();
    expect(equipment.seedDefaults).not.toHaveBeenCalled();
  });

  it('sibling seeders still run when the first one throws (fault isolation)', async () => {
    const { handler, wq, species, protocol, regulatory, equipment, bus } = makeHandler({
      wqError: new Error('wq db locked'),
    });
    await expect(
      handler.handle({
        eventType: 'TenantOnboardingRequested',
        tenantId: TENANT,
        operationId: OPERATION,
        generation: 1,
        name: 'x',
        slug: 'x',
        moduleIds: MODULES,
      } as TenantOnboardingRequestedEvent),
    ).resolves.toBeUndefined();
    expect(wq.seedDefaults).toHaveBeenCalledTimes(1);
    // Critical invariant: downstream seeders still run even though
    // WQ failed. A broken upstream seeder must not cascade into
    // skipped siblings — the tables are independent.
    expect(species.seedDefaults).toHaveBeenCalledWith(TENANT);
    expect(protocol.seedDefaults).toHaveBeenCalledWith(TENANT);
    expect(regulatory.seedDefaults).toHaveBeenCalledWith(TENANT);
    expect(equipment.seedDefaults).toHaveBeenCalledWith(TENANT);
    const [publishedEvent] = bus?.publish.mock.calls[0] ?? [];
    if (!publishedEvent || publishedEvent.eventType !== 'TenantOnboardingFailed') {
      throw new Error('Expected TenantOnboardingFailed event to be published');
    }
    expect(publishedEvent.tenantId).toBe(TENANT);
    expect(publishedEvent.operationId).toBe(OPERATION);
    expect(publishedEvent.generation).toBe(1);
    expect(publishedEvent.service).toBe('farm-service');
    expect(publishedEvent.error).toContain('water-quality-parameters: wq db locked');
  });

  it('all seeders failing publishes failed ack and does not rethrow', async () => {
    const { handler, wq, species, protocol, regulatory, equipment, bus } = makeHandler({
      wqError: new Error('wq db locked'),
      speciesError: new Error('species db locked'),
      protocolError: new Error('protocol db locked'),
      regulatoryError: new Error('regulatory db locked'),
      equipmentError: new Error('equipment check failed'),
    });
    await expect(
      handler.handle({
        eventType: 'TenantOnboardingRequested',
        tenantId: TENANT,
        operationId: OPERATION,
        generation: 1,
        name: 'x',
        slug: 'x',
        moduleIds: MODULES,
      } as TenantOnboardingRequestedEvent),
    ).resolves.toBeUndefined();
    expect(wq.seedDefaults).toHaveBeenCalledTimes(1);
    expect(species.seedDefaults).toHaveBeenCalledTimes(1);
    expect(protocol.seedDefaults).toHaveBeenCalledTimes(1);
    expect(regulatory.seedDefaults).toHaveBeenCalledTimes(1);
    expect(equipment.seedDefaults).toHaveBeenCalledTimes(1);
    expect(bus?.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'TenantOnboardingFailed',
        tenantId: TENANT,
        operationId: OPERATION,
        generation: 1,
        service: 'farm-service',
      }),
    );
  });

  it('fails closed onModuleInit when EventBus is unavailable', async () => {
    const { handler } = makeHandler({ eventBus: undefined });
    await expect(handler.onModuleInit()).rejects.toThrow(
      'EVENT_BUS is required for tenant onboarding ack/fail publication',
    );
  });

  it('subscribes via wildcard when EventBus is wired', async () => {
    const bus: BusDouble = {
      subscribeWildcard: jest.fn().mockResolvedValue(undefined),
      publish: jest
        .fn<Promise<void>, [TenantOnboardingAckEvent | TenantOnboardingFailedEvent]>()
        .mockResolvedValue(undefined),
    };
    const { handler } = makeHandler({ eventBus: bus });
    await handler.onModuleInit();
    expect(bus.subscribeWildcard).toHaveBeenCalledTimes(1);
    expect(bus.subscribeWildcard.mock.calls[0][0]).toBe('TenantOnboardingRequested');
  });
});
