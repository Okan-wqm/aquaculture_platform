import { canonicalWireJsonStringifyV1 } from '@aquaculture/shared-contracts';
import {
  PLATFORM_EVENT_REGISTRY,
  PLATFORM_EXTERNAL_NATS_PRINCIPALS,
  type PlatformEventRegistryEntry,
} from '@platform/event-contracts';
import {
  PLATFORM_SERVICE_CATALOG,
  type ServiceCatalogEntry,
  type ServiceNatsConsumerDeclaration,
} from '@platform/service-catalog';

import {
  assertServiceNatsHandlerSet,
  compileServiceNatsRuntimeProjection,
  createTenantOnboardingRequirementSnapshot,
  decodeTenantOnboardingRequirementSnapshot,
} from '../service-nats-runtime-profiles';

const ADMIN_SERVICE_ID = 'admin-api-service';

function adminDeclaration(): ServiceNatsConsumerDeclaration {
  const declaration = PLATFORM_SERVICE_CATALOG.find(
    (entry) => entry.serviceId === ADMIN_SERVICE_ID,
  )?.natsConsumer;
  if (!declaration) {
    throw new Error('test requires the governed admin NATS declaration');
  }
  return declaration;
}

function catalogWithAdminDeclaration(
  declaration: ServiceNatsConsumerDeclaration,
): ServiceCatalogEntry[] {
  return PLATFORM_SERVICE_CATALOG.map((entry) =>
    entry.serviceId === ADMIN_SERVICE_ID ? { ...entry, natsConsumer: declaration } : entry,
  );
}

function registryWith(
  key: string,
  replacement: PlatformEventRegistryEntry,
): Record<string, PlatformEventRegistryEntry> {
  return { ...PLATFORM_EVENT_REGISTRY, [key]: replacement };
}

describe('service NATS runtime profile compiler', () => {
  it('builds a deterministic admin profile from the two non-overlapping authorities', () => {
    const first = compileServiceNatsRuntimeProjection();
    const second = compileServiceNatsRuntimeProjection();
    const admin = first.profiles[ADMIN_SERVICE_ID];

    expect(admin).toBeDefined();
    expect(admin?.transport).toBe('event-bus');
    expect(admin?.readiness).toBe('required');
    expect(admin?.subscriptions.map(({ eventType }) => eventType)).toEqual([
      'TenantOnboardingAck',
      'TenantOnboardingFailed',
    ]);
    expect(admin?.subscriptions.map(({ producer }) => producer)).toEqual([
      'farm-service',
      'farm-service',
    ]);
    expect(canonicalWireJsonStringifyV1(first)).toBe(canonicalWireJsonStringifyV1(second));
    expect(first.projectionDigest).toBe(second.projectionDigest);
    expect(first.tenantOnboarding.requiredServices).toEqual(['farm-service']);
    expect(first.tenantOnboarding.ackDeadlineMs).toBe(900_000);

    const snapshot = createTenantOnboardingRequirementSnapshot(first.tenantOnboarding);
    expect(decodeTenantOnboardingRequirementSnapshot(snapshot, snapshot.snapshotDigest)).toEqual(
      snapshot,
    );
  });

  it('rejects drift between onboarding request consumers and outcome publishers', () => {
    const requested = PLATFORM_EVENT_REGISTRY.TenantOnboardingRequested;
    const registry = registryWith('TenantOnboardingRequested', {
      ...requested,
      consumers: ['farm-service', 'sensor-service'],
      acl: { ...requested.acl, subscribe: ['farm-service', 'sensor-service'] },
    });

    expect(() =>
      compileServiceNatsRuntimeProjection(
        PLATFORM_SERVICE_CATALOG,
        registry,
        PLATFORM_EXTERNAL_NATS_PRINCIPALS,
      ),
    ).toThrow('TenantOnboardingAck publishers must equal required onboarding services');
  });

  it('rejects a modified durable requirement snapshot', () => {
    const snapshot = createTenantOnboardingRequirementSnapshot();

    expect(() =>
      decodeTenantOnboardingRequirementSnapshot(
        { ...snapshot, requiredServices: ['sensor-service'] },
        snapshot.snapshotDigest,
      ),
    ).toThrow('digest mismatch');
  });

  it('decodes snapshots as an exact versioned contract with finite SHA-bound fields', () => {
    const snapshot = createTenantOnboardingRequirementSnapshot();

    expect(() =>
      decodeTenantOnboardingRequirementSnapshot(
        { ...snapshot, ungovernedDefault: true },
        snapshot.snapshotDigest,
      ),
    ).toThrow('invalid shape');
    expect(() =>
      decodeTenantOnboardingRequirementSnapshot(
        { ...snapshot, sourceProfileDigest: 'not-a-sha' },
        snapshot.snapshotDigest,
      ),
    ).toThrow('invalid shape');
    expect(() =>
      decodeTenantOnboardingRequirementSnapshot(
        { ...snapshot, ackDeadlineMs: Number.POSITIVE_INFINITY },
        snapshot.snapshotDigest,
      ),
    ).toThrow('canonical invariants');
    expect(() => decodeTenantOnboardingRequirementSnapshot(snapshot, 'not-a-sha')).toThrow(
      'invalid shape',
    );
  });

  it('rejects a catalog subscription that has no registry authority', () => {
    const declaration = adminDeclaration();
    const catalog = catalogWithAdminDeclaration({
      ...declaration,
      subscriptions: [
        ...declaration.subscriptions,
        {
          registryKey: 'UnregisteredAdminEvent',
          consumerVersion: 'tenant-onboarding-v1',
          durable: true,
        },
      ],
    });

    expect(() => compileServiceNatsRuntimeProjection(catalog)).toThrow(
      'unknown PLATFORM_EVENT_REGISTRY key UnregisteredAdminEvent',
    );
  });

  it('rejects duplicate runtime subscriptions at compile time', () => {
    const declaration = adminDeclaration();
    const firstSubscription = declaration.subscriptions[0];
    if (!firstSubscription) {
      throw new Error('test requires at least one admin NATS subscription');
    }
    const catalog = catalogWithAdminDeclaration({
      ...declaration,
      subscriptions: [firstSubscription, firstSubscription],
    });

    expect(() => compileServiceNatsRuntimeProjection(catalog)).toThrow('contains duplicate values');
  });

  it('rejects registry consumer and ACL divergence', () => {
    const ack = PLATFORM_EVENT_REGISTRY.TenantOnboardingAck;
    const registry = registryWith('TenantOnboardingAck', {
      ...ack,
      acl: { ...ack.acl, subscribe: [] },
    });

    expect(() =>
      compileServiceNatsRuntimeProjection(
        PLATFORM_SERVICE_CATALOG,
        registry,
        PLATFORM_EXTERNAL_NATS_PRINCIPALS,
      ),
    ).toThrow('TenantOnboardingAck consumers must equal acl.subscribe');
  });

  it('rejects a principal that exists in neither catalog nor external-principal authority', () => {
    const ack = PLATFORM_EVENT_REGISTRY.TenantOnboardingAck;
    const registry = registryWith('TenantOnboardingAck', {
      ...ack,
      producer: 'rogue-publisher',
      acl: { ...ack.acl, publish: ['rogue-publisher'] },
    });

    expect(() =>
      compileServiceNatsRuntimeProjection(
        PLATFORM_SERVICE_CATALOG,
        registry,
        PLATFORM_EXTERNAL_NATS_PRINCIPALS,
      ),
    ).toThrow('references unknown NATS principal rogue-publisher');
  });

  it('rejects an event-bus runtime binding to a command', () => {
    const ack = PLATFORM_EVENT_REGISTRY.TenantOnboardingAck;
    const registry = registryWith('TenantOnboardingAck', { ...ack, kind: 'command' });

    expect(() =>
      compileServiceNatsRuntimeProjection(
        PLATFORM_SERVICE_CATALOG,
        registry,
        PLATFORM_EXTERNAL_NATS_PRINCIPALS,
      ),
    ).toThrow('event-bus runtime cannot bind non-event registry key TenantOnboardingAck');
  });

  it('rejects missing, extra, misreported, and wrong-symbol runtime handlers', () => {
    const profile = compileServiceNatsRuntimeProjection().profiles[ADMIN_SERVICE_ID];
    if (!profile) {
      throw new Error('compiled admin profile is missing');
    }
    const ack = { getEventType: () => 'TenantOnboardingAck' };
    const failed = { getEventType: () => 'TenantOnboardingFailed' };

    expect(() =>
      assertServiceNatsHandlerSet(profile, profile.handlerSymbol, {
        TenantOnboardingAck: ack,
      }),
    ).toThrow('handler event set does not equal');
    expect(() =>
      assertServiceNatsHandlerSet(profile, profile.handlerSymbol, {
        TenantOnboardingAck: ack,
        TenantOnboardingFailed: failed,
        ExtraEvent: { getEventType: () => 'ExtraEvent' },
      }),
    ).toThrow('handler event set does not equal');
    expect(() =>
      assertServiceNatsHandlerSet(profile, profile.handlerSymbol, {
        TenantOnboardingAck: { getEventType: () => 'WrongEvent' },
        TenantOnboardingFailed: failed,
      }),
    ).toThrow('does not report the same event type');
    expect(() =>
      assertServiceNatsHandlerSet(profile, 'RenamedHandler', {
        TenantOnboardingAck: ack,
        TenantOnboardingFailed: failed,
      }),
    ).toThrow('does not equal catalog symbol');
  });
});
