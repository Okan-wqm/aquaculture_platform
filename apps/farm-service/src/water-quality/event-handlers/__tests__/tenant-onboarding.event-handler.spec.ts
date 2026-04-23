/**
 * TenantOnboardingEventHandler Unit Tests
 *
 * Exercises:
 *   - valid TenantCreated event → BOTH seeders run with tenantId
 *   - invalid tenantId format → neither seeder called
 *   - missing tenantId → neither seeder called
 *   - one seeder error → sibling still runs (fault isolation)
 *   - both seeders error → handler resolves (no rethrow)
 *   - EventBus absent (onModuleInit) → no subscription, no crash
 *   - getEventType returns 'TenantCreated'
 */
import { TenantOnboardingEventHandler } from '../tenant-onboarding.event-handler';
import { WaterQualityParameterConfigSeederService } from '../../services/water-quality-parameter-config-seeder.service';
import { SpeciesSeederService } from '../../../species/services/species-seeder.service';
import { FeedingProtocolSeederService } from '../../../feed/services/feeding-protocol-seeder.service';
import type { TenantCreatedEvent } from '@platform/event-contracts';

interface SeederDouble {
  seedDefaults: jest.Mock;
}

interface BusDouble {
  subscribeWildcard: jest.Mock;
}

function makeHandler(opts: {
  wqResult?: { seeded: string[]; skipped: string[] };
  wqError?: Error;
  speciesResult?: { seeded: string[]; skipped: string[] };
  speciesError?: Error;
  protocolResult?: { seeded: string[]; skipped: string[] };
  protocolError?: Error;
  eventBus?: BusDouble;
}): {
  handler: TenantOnboardingEventHandler;
  wq: SeederDouble;
  species: SeederDouble;
  protocol: SeederDouble;
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
  const handler = new TenantOnboardingEventHandler(
    wq as unknown as WaterQualityParameterConfigSeederService,
    species as unknown as SpeciesSeederService,
    protocol as unknown as FeedingProtocolSeederService,
    opts.eventBus as never,
  );
  (handler as unknown as { eventBus?: BusDouble }).eventBus = opts.eventBus;
  return { handler, wq, species, protocol, bus: opts.eventBus };
}

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('TenantOnboardingEventHandler', () => {
  it('returns the correct event type', () => {
    const { handler } = makeHandler({});
    expect(handler.getEventType()).toBe('TenantCreated');
  });

  it('runs every seeder on a valid TenantCreated event', async () => {
    const { handler, wq, species, protocol } = makeHandler({});
    await handler.handle({
      eventType: 'TenantCreated',
      tenantId: TENANT,
      name: 'Acme Salmon Farms',
      slug: 'acme',
    } as TenantCreatedEvent);
    expect(wq.seedDefaults).toHaveBeenCalledWith(TENANT);
    expect(species.seedDefaults).toHaveBeenCalledWith(TENANT);
    expect(protocol.seedDefaults).toHaveBeenCalledWith(TENANT);
  });

  it('skips every seeder when tenantId format is invalid', async () => {
    const { handler, wq, species, protocol } = makeHandler({});
    await handler.handle({
      eventType: 'TenantCreated',
      tenantId: 'not-a-uuid',
      name: 'Malformed',
      slug: 'bad',
    } as TenantCreatedEvent);
    expect(wq.seedDefaults).not.toHaveBeenCalled();
    expect(species.seedDefaults).not.toHaveBeenCalled();
    expect(protocol.seedDefaults).not.toHaveBeenCalled();
  });

  it('skips every seeder when tenantId is missing', async () => {
    const { handler, wq, species, protocol } = makeHandler({});
    await handler.handle({
      eventType: 'TenantCreated',
      name: 'Missing',
      slug: 'missing',
    } as unknown as TenantCreatedEvent);
    expect(wq.seedDefaults).not.toHaveBeenCalled();
    expect(species.seedDefaults).not.toHaveBeenCalled();
    expect(protocol.seedDefaults).not.toHaveBeenCalled();
  });

  it('sibling seeders still run when the first one throws (fault isolation)', async () => {
    const { handler, wq, species, protocol } = makeHandler({
      wqError: new Error('wq db locked'),
    });
    await expect(
      handler.handle({
        eventType: 'TenantCreated',
        tenantId: TENANT,
        name: 'x',
        slug: 'x',
      } as TenantCreatedEvent),
    ).resolves.toBeUndefined();
    expect(wq.seedDefaults).toHaveBeenCalledTimes(1);
    // Critical invariant: species + protocol seeders still run
    // even though WQ failed. A broken upstream seeder must not
    // cascade into skipped downstream seeders — the tables are
    // independent.
    expect(species.seedDefaults).toHaveBeenCalledWith(TENANT);
    expect(protocol.seedDefaults).toHaveBeenCalledWith(TENANT);
  });

  it('all seeders failing does not rethrow', async () => {
    const { handler, wq, species, protocol } = makeHandler({
      wqError: new Error('wq db locked'),
      speciesError: new Error('species db locked'),
      protocolError: new Error('protocol db locked'),
    });
    await expect(
      handler.handle({
        eventType: 'TenantCreated',
        tenantId: TENANT,
        name: 'x',
        slug: 'x',
      } as TenantCreatedEvent),
    ).resolves.toBeUndefined();
    expect(wq.seedDefaults).toHaveBeenCalledTimes(1);
    expect(species.seedDefaults).toHaveBeenCalledTimes(1);
    expect(protocol.seedDefaults).toHaveBeenCalledTimes(1);
  });

  it('no-ops onModuleInit when EventBus is unavailable', async () => {
    const { handler } = makeHandler({ eventBus: undefined });
    await expect(handler.onModuleInit()).resolves.toBeUndefined();
  });

  it('subscribes via wildcard when EventBus is wired', async () => {
    const bus: BusDouble = {
      subscribeWildcard: jest.fn().mockResolvedValue(undefined),
    };
    const { handler } = makeHandler({ eventBus: bus });
    await handler.onModuleInit();
    expect(bus.subscribeWildcard).toHaveBeenCalledTimes(1);
    expect(bus.subscribeWildcard.mock.calls[0][0]).toBe('TenantCreated');
  });
});
