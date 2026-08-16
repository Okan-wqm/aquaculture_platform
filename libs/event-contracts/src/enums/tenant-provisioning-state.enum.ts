/**
 * Canonical public state machine vocabulary for asynchronous tenant
 * provisioning operations. Persistence, HTTP projections, and UI polling all
 * consume this enum; transition legality remains owned by the workflow service.
 */
export const TenantProvisioningState = Object.freeze({
  QUEUED: 'QUEUED',
  RESERVING: 'RESERVING',
  RUNNING: 'RUNNING',
  WAITING_ONBOARDING: 'WAITING_ONBOARDING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
} as const);

export type TenantProvisioningState =
  (typeof TenantProvisioningState)[keyof typeof TenantProvisioningState];
