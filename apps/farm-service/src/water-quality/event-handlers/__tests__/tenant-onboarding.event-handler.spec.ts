/**
 * TenantOnboardingEventHandler Unit Tests
 *
 * Exercises:
 *   - valid TenantCreated event → seeder runs with tenantId
 *   - invalid tenantId format → seeder NOT called
 *   - missing tenantId → seeder NOT called
 *   - seeder error → logged, no rethrow
 *   - EventBus absent (onModuleInit) → no subscription, no crash
 *   - getEventType returns 'TenantCreated'
 */
import { TenantOnboardingEventHandler } from '../tenant-onboarding.event-handler';
import { WaterQualityParameterConfigSeederService } from '../../services/water-quality-parameter-config-seeder.service';
import type { TenantCreatedEvent } from '@platform/event-contracts';

interface SeederDouble {
  seedDefaults: jest.Mock;
}

interface BusDouble {
  subscribeWildcard: jest.Mock;
}

function makeHandler(opts: {
  seederResult?: { seeded: string[]; skipped: string[] };
  seederError?: Error;
  eventBus?: BusDouble;
}): {
  handler: TenantOnboardingEventHandler;
  seeder: SeederDouble;
  bus?: BusDouble;
} {
  const seeder: SeederDouble = {
    seedDefaults: jest.fn().mockImplementation(async () => {
      if (opts.seederError) throw opts.seederError;
      return opts.seederResult ?? { seeded: ['temperature'], skipped: [] };
    }),
  };
  const handler = new TenantOnboardingEventHandler(
    seeder as unknown as WaterQualityParameterConfigSeederService,
    opts.eventBus as unknown as Parameters<
      typeof TenantOnboardingEventHandler.prototype.onModuleInit
    > extends [] ? never : undefined,
  );
  // Access the @Optional() protected/private property via cast so
  // the handler respects the injected bus during onModuleInit.
  (handler as unknown as { eventBus?: BusDouble }).eventBus = opts.eventBus;
  return { handler, seeder, bus: opts.eventBus };
}

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('TenantOnboardingEventHandler', () => {
  it('returns the correct event type', () => {
    const { handler } = makeHandler({});
    expect(handler.getEventType()).toBe('TenantCreated');
  });

  it('seeds default configs on a valid TenantCreated event', async () => {
    const { handler, seeder } = makeHandler({});
    await handler.handle({
      eventType: 'TenantCreated',
      tenantId: TENANT,
      name: 'Acme Salmon Farms',
      slug: 'acme',
    } as TenantCreatedEvent);
    expect(seeder.seedDefaults).toHaveBeenCalledWith(TENANT);
  });

  it('skips seeding when tenantId format is invalid', async () => {
    const { handler, seeder } = makeHandler({});
    await handler.handle({
      eventType: 'TenantCreated',
      tenantId: 'not-a-uuid',
      name: 'Malformed',
      slug: 'bad',
    } as TenantCreatedEvent);
    expect(seeder.seedDefaults).not.toHaveBeenCalled();
  });

  it('skips seeding when tenantId is missing', async () => {
    const { handler, seeder } = makeHandler({});
    await handler.handle({
      eventType: 'TenantCreated',
      name: 'Missing',
      slug: 'missing',
    } as unknown as TenantCreatedEvent);
    expect(seeder.seedDefaults).not.toHaveBeenCalled();
  });

  it('logs + continues when the seeder throws (no rethrow)', async () => {
    const { handler } = makeHandler({
      seederError: new Error('database locked'),
    });
    await expect(
      handler.handle({
        eventType: 'TenantCreated',
        tenantId: TENANT,
        name: 'x',
        slug: 'x',
      } as TenantCreatedEvent),
    ).resolves.toBeUndefined();
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
