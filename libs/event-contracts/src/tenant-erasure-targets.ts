/**
 * Canonical GDPR Art. 17 tenant-erasure target and outcome-subject registry.
 *
 * Each target has three distinct event types because the NATS event type is
 * the final subject token. Per-target types let the broker bind an outcome to
 * the publisher's mTLS certificate: a farm-service certificate can publish
 * FarmServiceTenantDataErased, but cannot publish another target's proof.
 *
 * This mapping is the SSoT. The target roster, event-type unions, subject
 * patterns, producers, consumers, schemas, and ACL invariants are all derived
 * from it; do not duplicate a second target or outcome-event list.
 */
export const TENANT_ERASURE_OUTCOME_EVENT_TYPES_BY_TARGET = {
  'farm-service': {
    erased: 'FarmServiceTenantDataErased',
    failed: 'FarmServiceTenantDataErasureFailed',
    blocked: 'FarmServiceTenantErasureBlocked',
  },
  'sensor-service': {
    erased: 'SensorServiceTenantDataErased',
    failed: 'SensorServiceTenantDataErasureFailed',
    blocked: 'SensorServiceTenantErasureBlocked',
  },
  'hr-service': {
    erased: 'HrServiceTenantDataErased',
    failed: 'HrServiceTenantDataErasureFailed',
    blocked: 'HrServiceTenantErasureBlocked',
  },
  'messaging-service': {
    erased: 'MessagingServiceTenantDataErased',
    failed: 'MessagingServiceTenantDataErasureFailed',
    blocked: 'MessagingServiceTenantErasureBlocked',
  },
  'ai-service': {
    erased: 'AiServiceTenantDataErased',
    failed: 'AiServiceTenantDataErasureFailed',
    blocked: 'AiServiceTenantErasureBlocked',
  },
  'billing-service': {
    erased: 'BillingServiceTenantDataErased',
    failed: 'BillingServiceTenantDataErasureFailed',
    blocked: 'BillingServiceTenantErasureBlocked',
  },
  'notification-service': {
    erased: 'NotificationServiceTenantDataErased',
    failed: 'NotificationServiceTenantDataErasureFailed',
    blocked: 'NotificationServiceTenantErasureBlocked',
  },
  'hydroponics-service': {
    erased: 'HydroponicsServiceTenantDataErased',
    failed: 'HydroponicsServiceTenantDataErasureFailed',
    blocked: 'HydroponicsServiceTenantErasureBlocked',
  },
  'alert-engine': {
    erased: 'AlertEngineTenantDataErased',
    failed: 'AlertEngineTenantDataErasureFailed',
    blocked: 'AlertEngineTenantErasureBlocked',
  },
  'admin-api-service': {
    erased: 'AdminApiServiceTenantDataErased',
    failed: 'AdminApiServiceTenantDataErasureFailed',
    blocked: 'AdminApiServiceTenantErasureBlocked',
  },
  'config-service': {
    erased: 'ConfigServiceTenantDataErased',
    failed: 'ConfigServiceTenantDataErasureFailed',
    blocked: 'ConfigServiceTenantErasureBlocked',
  },
  'event-store-service': {
    erased: 'EventStoreServiceTenantDataErased',
    failed: 'EventStoreServiceTenantDataErasureFailed',
    blocked: 'EventStoreServiceTenantErasureBlocked',
  },
} as const;

export type TenantErasureTargetService = keyof typeof TENANT_ERASURE_OUTCOME_EVENT_TYPES_BY_TARGET;

function typedKeys<T extends object>(value: T): Array<keyof T> {
  return Object.keys(value) as Array<keyof T>;
}

export const TENANT_ERASURE_TARGET_SERVICES: readonly TenantErasureTargetService[] = Object.freeze(
  typedKeys(TENANT_ERASURE_OUTCOME_EVENT_TYPES_BY_TARGET),
);

export const TENANT_ERASURE_TARGET_SERVICE_COUNT = TENANT_ERASURE_TARGET_SERVICES.length;

export const TENANT_ERASURE_OUTCOME_KINDS = ['erased', 'failed', 'blocked'] as const;

export type TenantErasureOutcomeKind = (typeof TENANT_ERASURE_OUTCOME_KINDS)[number];

type TenantErasureOutcomeEventTypeMapping = typeof TENANT_ERASURE_OUTCOME_EVENT_TYPES_BY_TARGET;

export type TenantDataErasedEventType =
  TenantErasureOutcomeEventTypeMapping[TenantErasureTargetService]['erased'];
export type TenantDataErasureFailedEventType =
  TenantErasureOutcomeEventTypeMapping[TenantErasureTargetService]['failed'];
export type TenantErasureBlockedEventType =
  TenantErasureOutcomeEventTypeMapping[TenantErasureTargetService]['blocked'];
export type TenantErasureOutcomeEventType =
  | TenantDataErasedEventType
  | TenantDataErasureFailedEventType
  | TenantErasureBlockedEventType;

export type TenantErasureOutcomeSubject = `events.*.${TenantErasureOutcomeEventType}`;

export interface TenantErasureOutcomeEventTypeResolution {
  readonly targetService: TenantErasureTargetService;
  readonly outcome: TenantErasureOutcomeKind;
  readonly eventType: TenantErasureOutcomeEventType;
}

export function tenantErasureOutcomeEventType<
  TTarget extends TenantErasureTargetService,
  TOutcome extends TenantErasureOutcomeKind,
>(
  targetService: TTarget,
  outcome: TOutcome,
): TenantErasureOutcomeEventTypeMapping[TTarget][TOutcome] {
  return TENANT_ERASURE_OUTCOME_EVENT_TYPES_BY_TARGET[targetService][outcome];
}

export function tenantErasureOutcomeSubject(
  targetService: TenantErasureTargetService,
  outcome: TenantErasureOutcomeKind,
): TenantErasureOutcomeSubject {
  return `events.*.${tenantErasureOutcomeEventType(targetService, outcome)}`;
}

export function resolveTenantErasureOutcomeEventType(
  eventType: string,
): TenantErasureOutcomeEventTypeResolution | null {
  for (const targetService of TENANT_ERASURE_TARGET_SERVICES) {
    for (const outcome of TENANT_ERASURE_OUTCOME_KINDS) {
      const mappedEventType = tenantErasureOutcomeEventType(targetService, outcome);
      if (mappedEventType === eventType) {
        return { targetService, outcome, eventType: mappedEventType };
      }
    }
  }
  return null;
}

export function isTenantErasureTargetService(
  service: string,
): service is TenantErasureTargetService {
  return Object.prototype.hasOwnProperty.call(
    TENANT_ERASURE_OUTCOME_EVENT_TYPES_BY_TARGET,
    service,
  );
}
