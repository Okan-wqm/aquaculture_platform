/**
 * Versioned tenant-onboarding workflow catalogue.
 *
 * This is the single authority for the coordinator, required owner services,
 * event names/subjects, durable-consumer revision, receipt lease and
 * acknowledgement deadline. Runtime services project their subscriptions,
 * quorum and retry timing from this object; none of those values belong in
 * environment variables or hand-copied arrays.
 */
export const TENANT_ONBOARDING_WORKFLOW_V1 = {
  schemaVersion: 1,
  coordinatorService: 'admin-api-service',
  ownerServices: ['farm-service'],
  request: {
    eventType: 'TenantOnboardingRequested',
    subject: 'events.{tenantId}.TenantOnboardingRequested',
    producer: 'admin-api-service',
  },
  acknowledgement: {
    eventType: 'TenantOnboardingAck',
    subject: 'events.{tenantId}.TenantOnboardingAck',
  },
  failure: {
    eventType: 'TenantOnboardingFailed',
    subject: 'events.{tenantId}.TenantOnboardingFailed',
  },
  subscription: {
    consumerVersion: 'tenant-onboarding-v1',
    startFrom: 'beginning',
    ackWaitSeconds: 120,
    maxDeliveries: 20,
  },
  ownerReceiptLeaseSeconds: 180,
  acknowledgementDeadlineSeconds: 600,
} as const;

export type TenantOnboardingOwnerService =
  (typeof TENANT_ONBOARDING_WORKFLOW_V1.ownerServices)[number];
