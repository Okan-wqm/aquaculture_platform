import { canonicalWireJsonStringifyV1, sha256Hex } from '@aquaculture/shared-contracts';
import {
  PLATFORM_EVENT_REGISTRY,
  PLATFORM_EXTERNAL_NATS_PRINCIPALS,
  type PlatformEventRegistryEntry,
  type PlatformExternalNatsPrincipal,
} from '@platform/event-contracts';
import {
  PLATFORM_SERVICE_CATALOG,
  type ServiceCatalogEntry,
  type ServiceNatsConsumerDeclaration,
} from '@platform/service-catalog';

const PROFILE_SCHEMA_VERSION = 'service-nats-runtime-profile.v1' as const;
const PROJECTION_SCHEMA_VERSION = 'service-nats-runtime-projection.v1' as const;
const ONBOARDING_PROFILE_SCHEMA_VERSION = 'tenant-onboarding-requirement-profile.v1' as const;
const ONBOARDING_SNAPSHOT_SCHEMA_VERSION = 'tenant-onboarding-requirement-snapshot.v1' as const;
const CONSUMER_VERSION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HANDLER_SYMBOL_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ONBOARDING_SNAPSHOT_KEYS = Object.freeze([
  'ackDeadlineMs',
  'requiredServices',
  'retryIntervalMs',
  'schemaVersion',
  'snapshotDigest',
  'sourceProfileDigest',
] as const);

export interface ServiceNatsRuntimeSubscriptionV1 {
  readonly registryKey: string;
  readonly eventType: string;
  readonly producer: string;
  readonly subject: string;
  readonly wildcardSubject: string;
  readonly schema: string;
  readonly fixture: string;
  readonly durability: PlatformEventRegistryEntry['durability'];
  readonly consumerVersion: string;
  readonly durable: true;
}

export interface ServiceNatsRuntimeProfileV1 {
  readonly schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  readonly serviceId: string;
  readonly transport: 'event-bus';
  readonly handlerSymbol: string;
  readonly readiness: 'required';
  readonly subscriptions: readonly ServiceNatsRuntimeSubscriptionV1[];
  readonly profileDigest: string;
}

export interface ServiceNatsRuntimeProjectionV1 {
  readonly schemaVersion: typeof PROJECTION_SCHEMA_VERSION;
  readonly authority: 'platform-service-catalog+platform-event-registry';
  readonly profiles: Readonly<Record<string, ServiceNatsRuntimeProfileV1>>;
  readonly tenantOnboarding: TenantOnboardingRequirementProfileV1;
  readonly projectionDigest: string;
}

export interface TenantOnboardingRequirementProfileV1 {
  readonly schemaVersion: typeof ONBOARDING_PROFILE_SCHEMA_VERSION;
  readonly coordinatorServiceId: string;
  readonly requestedRegistryKey: 'TenantOnboardingRequested';
  readonly acknowledgementRegistryKeys: readonly ['TenantOnboardingAck', 'TenantOnboardingFailed'];
  readonly requiredServices: readonly string[];
  readonly ackDeadlineMs: number;
  readonly retryIntervalMs: number;
  readonly profileDigest: string;
}

export interface TenantOnboardingRequirementSnapshotV1 {
  readonly schemaVersion: typeof ONBOARDING_SNAPSHOT_SCHEMA_VERSION;
  readonly sourceProfileDigest: string;
  readonly requiredServices: readonly string[];
  readonly ackDeadlineMs: number;
  readonly retryIntervalMs: number;
  readonly snapshotDigest: string;
}

export interface RuntimeEventHandlerBinding {
  readonly getEventType: () => string;
}

type EventRegistry = Readonly<Record<string, PlatformEventRegistryEntry>>;
type ExternalPrincipalRegistry = Readonly<Record<string, PlatformExternalNatsPrincipal>>;

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicate values`);
  }
}

function assertRegistryPrincipals(
  catalog: readonly ServiceCatalogEntry[],
  registry: EventRegistry,
  externalPrincipals: ExternalPrincipalRegistry,
): void {
  const catalogIds = new Set(catalog.map((entry) => entry.serviceId));
  const referencedExternalIds = new Set<string>();

  for (const [principalId, principal] of Object.entries(externalPrincipals)) {
    if (principal.principalId !== principalId) {
      throw new Error(
        `External NATS principal key ${principalId} does not match principalId ${principal.principalId}`,
      );
    }
    if (!ISO_DATE_PATTERN.test(principal.expiresAt)) {
      throw new Error(`External NATS principal ${principalId} has an invalid expiresAt date`);
    }
  }

  for (const [registryKey, entry] of Object.entries(registry)) {
    if (entry.type !== registryKey) {
      throw new Error(
        `PLATFORM_EVENT_REGISTRY key ${registryKey} must equal its event type ${entry.type}`,
      );
    }
    assertUnique(entry.consumers, `${registryKey}.consumers`);
    assertUnique(entry.acl.publish, `${registryKey}.acl.publish`);
    assertUnique(entry.acl.subscribe, `${registryKey}.acl.subscribe`);

    if (
      canonicalWireJsonStringifyV1(sortedUnique(entry.consumers)) !==
      canonicalWireJsonStringifyV1(sortedUnique(entry.acl.subscribe))
    ) {
      throw new Error(`${registryKey} consumers must equal acl.subscribe`);
    }
    if (
      canonicalWireJsonStringifyV1([entry.producer]) !==
      canonicalWireJsonStringifyV1(sortedUnique(entry.acl.publish))
    ) {
      throw new Error(`${registryKey} producer must equal acl.publish`);
    }

    for (const principalId of [
      entry.producer,
      ...entry.consumers,
      ...entry.acl.publish,
      ...entry.acl.subscribe,
    ]) {
      if (catalogIds.has(principalId)) {
        continue;
      }
      const external = externalPrincipals[principalId];
      if (!external) {
        throw new Error(
          `${registryKey} references unknown NATS principal ${principalId}; add a Service Catalog entry or an explicit external principal`,
        );
      }
      referencedExternalIds.add(principalId);
      if (entry.aliasExpiresAt !== external.expiresAt) {
        throw new Error(
          `${registryKey} aliasExpiresAt must equal external principal ${principalId} expiresAt`,
        );
      }
    }
  }

  const declaredExternalIds = Object.keys(externalPrincipals).sort();
  if (
    canonicalWireJsonStringifyV1([...referencedExternalIds].sort()) !==
    canonicalWireJsonStringifyV1(declaredExternalIds)
  ) {
    throw new Error('External NATS principal declarations must exactly equal registry references');
  }
}

function compileProfile(
  service: ServiceCatalogEntry,
  declaration: ServiceNatsConsumerDeclaration,
  registry: EventRegistry,
): ServiceNatsRuntimeProfileV1 {
  if (service.buildKind !== 'node-service') {
    throw new Error(`${service.serviceId} NATS runtime profile requires buildKind=node-service`);
  }
  if (!HANDLER_SYMBOL_PATTERN.test(declaration.handlerSymbol)) {
    throw new Error(`${service.serviceId} has an invalid NATS handler symbol`);
  }
  if (declaration.subscriptions.length === 0) {
    throw new Error(`${service.serviceId} NATS runtime profile has no subscriptions`);
  }

  const registryKeys = declaration.subscriptions.map((subscription) => subscription.registryKey);
  assertUnique(registryKeys, `${service.serviceId}.natsConsumer.subscriptions`);

  const subscriptions = Object.freeze(
    declaration.subscriptions
      .map((subscription): ServiceNatsRuntimeSubscriptionV1 => {
        const entry = registry[subscription.registryKey];
        if (!entry) {
          throw new Error(
            `${service.serviceId} references unknown PLATFORM_EVENT_REGISTRY key ${subscription.registryKey}`,
          );
        }
        if (entry.kind !== 'event') {
          throw new Error(
            `${service.serviceId} event-bus runtime cannot bind non-event registry key ${subscription.registryKey}`,
          );
        }
        if (!entry.consumers.includes(service.serviceId)) {
          throw new Error(
            `${service.serviceId} is not a declared consumer of ${subscription.registryKey}`,
          );
        }
        if (!entry.acl.subscribe.includes(service.serviceId)) {
          throw new Error(
            `${service.serviceId} lacks subscribe ACL for ${subscription.registryKey}`,
          );
        }
        const expectedSubject = `events.{tenantId}.${entry.type}`;
        if (entry.subject !== expectedSubject) {
          throw new Error(
            `${subscription.registryKey} subject ${entry.subject} must equal ${expectedSubject} for event-bus wildcard binding`,
          );
        }
        if (!CONSUMER_VERSION_PATTERN.test(subscription.consumerVersion)) {
          throw new Error(
            `${service.serviceId}/${subscription.registryKey} has an invalid consumerVersion`,
          );
        }

        return Object.freeze({
          registryKey: subscription.registryKey,
          eventType: entry.type,
          producer: entry.producer,
          subject: entry.subject,
          wildcardSubject: entry.subject.replace('{tenantId}', '*'),
          schema: entry.schema,
          fixture: entry.fixture,
          durability: entry.durability,
          consumerVersion: subscription.consumerVersion,
          durable: subscription.durable,
        });
      })
      .sort((left, right) => left.registryKey.localeCompare(right.registryKey)),
  );

  const core = {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    serviceId: service.serviceId,
    transport: declaration.adapter,
    handlerSymbol: declaration.handlerSymbol,
    readiness: declaration.readiness,
    subscriptions,
  } as const;

  return Object.freeze({
    ...core,
    profileDigest: sha256Hex(`${PROFILE_SCHEMA_VERSION}\0${canonicalWireJsonStringifyV1(core)}`),
  });
}

function compileTenantOnboardingRequirementProfile(
  catalog: readonly ServiceCatalogEntry[],
  registry: EventRegistry,
): TenantOnboardingRequirementProfileV1 {
  const coordinatorServiceId = 'admin-api-service';
  const coordinator = catalog.find((entry) => entry.serviceId === coordinatorServiceId);
  const barrier = coordinator?.natsConsumer?.tenantOnboardingBarrier;
  if (!coordinator || !barrier) {
    throw new Error(`${coordinatorServiceId} must own the tenant onboarding barrier policy`);
  }
  if (
    !Number.isSafeInteger(barrier.ackDeadlineMs) ||
    !Number.isSafeInteger(barrier.retryIntervalMs) ||
    barrier.retryIntervalMs <= 0 ||
    barrier.ackDeadlineMs <= barrier.retryIntervalMs
  ) {
    throw new Error('Tenant onboarding barrier timing policy is invalid');
  }

  const requested = registry.TenantOnboardingRequested;
  const acknowledged = registry.TenantOnboardingAck;
  const failed = registry.TenantOnboardingFailed;
  if (!requested || !acknowledged || !failed) {
    throw new Error('Tenant onboarding registry triplet is incomplete');
  }

  const requiredServices = Object.freeze(sortedUnique(requested.consumers));
  if (requiredServices.length === 0) {
    throw new Error('Tenant onboarding requires at least one owner service');
  }
  const catalogById = new Map(catalog.map((entry) => [entry.serviceId, entry]));
  for (const serviceId of requiredServices) {
    const service = catalogById.get(serviceId);
    if (!service || service.deploymentStatus !== 'active' || service.buildKind !== 'node-service') {
      throw new Error(
        `Tenant onboarding required service ${serviceId} must be an active node-service`,
      );
    }
  }

  for (const [registryKey, outcome] of [
    ['TenantOnboardingAck', acknowledged],
    ['TenantOnboardingFailed', failed],
  ] as const) {
    if (
      canonicalWireJsonStringifyV1(sortedUnique(outcome.acl.publish)) !==
      canonicalWireJsonStringifyV1(requiredServices)
    ) {
      throw new Error(`${registryKey} publishers must equal required onboarding services`);
    }
    if (!outcome.consumers.includes(coordinatorServiceId)) {
      throw new Error(`${registryKey} must be consumed by ${coordinatorServiceId}`);
    }
  }

  const core = {
    schemaVersion: ONBOARDING_PROFILE_SCHEMA_VERSION,
    coordinatorServiceId,
    requestedRegistryKey: 'TenantOnboardingRequested',
    acknowledgementRegistryKeys: ['TenantOnboardingAck', 'TenantOnboardingFailed'] as const,
    requiredServices,
    ackDeadlineMs: barrier.ackDeadlineMs,
    retryIntervalMs: barrier.retryIntervalMs,
  } as const;

  return Object.freeze({
    ...core,
    profileDigest: sha256Hex(
      `${ONBOARDING_PROFILE_SCHEMA_VERSION}\0${canonicalWireJsonStringifyV1(core)}`,
    ),
  });
}

export function compileServiceNatsRuntimeProjection(
  catalog: readonly ServiceCatalogEntry[] = PLATFORM_SERVICE_CATALOG,
  registry: EventRegistry = PLATFORM_EVENT_REGISTRY,
  externalPrincipals: ExternalPrincipalRegistry = PLATFORM_EXTERNAL_NATS_PRINCIPALS,
): ServiceNatsRuntimeProjectionV1 {
  assertRegistryPrincipals(catalog, registry, externalPrincipals);

  const profiles: Record<string, ServiceNatsRuntimeProfileV1> = {};
  for (const service of [...catalog].sort((left, right) =>
    left.serviceId.localeCompare(right.serviceId),
  )) {
    if (!service.natsConsumer) {
      continue;
    }
    if (profiles[service.serviceId]) {
      throw new Error(`Duplicate NATS runtime profile for ${service.serviceId}`);
    }
    profiles[service.serviceId] = compileProfile(service, service.natsConsumer, registry);
  }

  const frozenProfiles = Object.freeze(profiles);
  const tenantOnboarding = compileTenantOnboardingRequirementProfile(catalog, registry);
  const core = {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    authority: 'platform-service-catalog+platform-event-registry',
    profiles: frozenProfiles,
    tenantOnboarding,
  } as const;

  return Object.freeze({
    ...core,
    projectionDigest: sha256Hex(
      `${PROJECTION_SCHEMA_VERSION}\0${canonicalWireJsonStringifyV1(core)}`,
    ),
  });
}

export const SERVICE_NATS_RUNTIME_PROJECTION = compileServiceNatsRuntimeProjection();
export const SERVICE_NATS_RUNTIME_PROFILES = SERVICE_NATS_RUNTIME_PROJECTION.profiles;
export const TENANT_ONBOARDING_REQUIREMENT_PROFILE =
  SERVICE_NATS_RUNTIME_PROJECTION.tenantOnboarding;

export function createTenantOnboardingRequirementSnapshot(
  profile: TenantOnboardingRequirementProfileV1 = TENANT_ONBOARDING_REQUIREMENT_PROFILE,
): TenantOnboardingRequirementSnapshotV1 {
  const core = {
    schemaVersion: ONBOARDING_SNAPSHOT_SCHEMA_VERSION,
    sourceProfileDigest: profile.profileDigest,
    requiredServices: Object.freeze([...profile.requiredServices]),
    ackDeadlineMs: profile.ackDeadlineMs,
    retryIntervalMs: profile.retryIntervalMs,
  } as const;
  return Object.freeze({
    ...core,
    snapshotDigest: sha256Hex(
      `${ONBOARDING_SNAPSHOT_SCHEMA_VERSION}\0${canonicalWireJsonStringifyV1(core)}`,
    ),
  });
}

export function decodeTenantOnboardingRequirementSnapshot(
  value: unknown,
  expectedDigest: string,
): TenantOnboardingRequirementSnapshotV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Tenant onboarding requirement snapshot must be an object');
  }
  const candidate = value as Record<string, unknown>;
  const requiredServices = candidate.requiredServices;
  if (
    canonicalWireJsonStringifyV1(Object.keys(candidate).sort()) !==
      canonicalWireJsonStringifyV1(ONBOARDING_SNAPSHOT_KEYS) ||
    candidate.schemaVersion !== ONBOARDING_SNAPSHOT_SCHEMA_VERSION ||
    typeof candidate.sourceProfileDigest !== 'string' ||
    !SHA256_PATTERN.test(candidate.sourceProfileDigest) ||
    !Array.isArray(requiredServices) ||
    !requiredServices.every(
      (service): service is string => typeof service === 'string' && service.length > 0,
    ) ||
    typeof candidate.ackDeadlineMs !== 'number' ||
    typeof candidate.retryIntervalMs !== 'number' ||
    typeof candidate.snapshotDigest !== 'string' ||
    !SHA256_PATTERN.test(candidate.snapshotDigest) ||
    !SHA256_PATTERN.test(expectedDigest)
  ) {
    throw new Error('Tenant onboarding requirement snapshot has an invalid shape');
  }
  if (
    canonicalWireJsonStringifyV1(requiredServices) !==
      canonicalWireJsonStringifyV1(sortedUnique(requiredServices)) ||
    requiredServices.length === 0 ||
    !Number.isSafeInteger(candidate.ackDeadlineMs) ||
    !Number.isSafeInteger(candidate.retryIntervalMs) ||
    candidate.retryIntervalMs <= 0 ||
    candidate.ackDeadlineMs <= candidate.retryIntervalMs
  ) {
    throw new Error('Tenant onboarding requirement snapshot violates canonical invariants');
  }

  const core = {
    schemaVersion: candidate.schemaVersion,
    sourceProfileDigest: candidate.sourceProfileDigest,
    requiredServices: Object.freeze([...requiredServices]),
    ackDeadlineMs: candidate.ackDeadlineMs,
    retryIntervalMs: candidate.retryIntervalMs,
  } as const;
  const actualDigest = sha256Hex(
    `${ONBOARDING_SNAPSHOT_SCHEMA_VERSION}\0${canonicalWireJsonStringifyV1(core)}`,
  );
  if (candidate.snapshotDigest !== actualDigest || expectedDigest !== actualDigest) {
    throw new Error('Tenant onboarding requirement snapshot digest mismatch');
  }

  return Object.freeze({ ...core, snapshotDigest: actualDigest });
}

export function requireServiceNatsRuntimeProfile(serviceId: string): ServiceNatsRuntimeProfileV1 {
  const profile = SERVICE_NATS_RUNTIME_PROFILES[serviceId];
  if (!profile) {
    throw new Error(`No governed NATS runtime profile exists for ${serviceId}`);
  }
  return profile;
}

export function assertServiceNatsHandlerSet(
  profile: ServiceNatsRuntimeProfileV1,
  handlerSymbol: string,
  handlers: Readonly<Record<string, RuntimeEventHandlerBinding>>,
): void {
  if (handlerSymbol !== profile.handlerSymbol) {
    throw new Error(
      `${profile.serviceId} runtime handler symbol ${handlerSymbol} does not equal catalog symbol ${profile.handlerSymbol}`,
    );
  }

  const expectedEventTypes = profile.subscriptions
    .map((subscription) => subscription.eventType)
    .sort();
  const actualEventTypes = Object.keys(handlers).sort();
  if (
    canonicalWireJsonStringifyV1(actualEventTypes) !==
    canonicalWireJsonStringifyV1(expectedEventTypes)
  ) {
    throw new Error(
      `${profile.serviceId} handler event set does not equal its derived runtime profile`,
    );
  }

  for (const eventType of actualEventTypes) {
    const handler = handlers[eventType];
    if (!handler || handler.getEventType() !== eventType) {
      throw new Error(
        `${profile.serviceId} handler binding ${eventType} does not report the same event type`,
      );
    }
  }
}
