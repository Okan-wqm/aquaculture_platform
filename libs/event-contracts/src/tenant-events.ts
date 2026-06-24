import { BaseEvent, PlanTier, BillingCycle } from './base-event';
import { TenantStatus } from './enums/tenant-status.enum';
import type { TenantErasureTargetService } from './tenant-erasure-targets';

/**
 * Tenant Created Event
 * Published when a new tenant is registered in the system
 */
export interface TenantCreatedEvent extends BaseEvent {
  eventType: 'TenantCreated';
  name: string;
  slug: string;
  plan?: string;
  status?: string;
}

/**
 * Tenant Provisioning Requested Event
 * Published when the admin-api tenant workflow has durably accepted a
 * provisioning operation and is beginning owner-service setup.
 */
export interface TenantProvisioningRequestedEvent extends BaseEvent {
  eventType: 'TenantProvisioningRequested';
  operationId: string;
  name: string;
  slug: string;
  moduleIds: string[];
}

/**
 * Tenant Onboarding Requested Event
 * Published by the tenant workflow after owner services are ready and before
 * final TenantProvisioned. Domain services must durably ack or fail.
 */
export interface TenantOnboardingRequestedEvent extends BaseEvent {
  eventType: 'TenantOnboardingRequested';
  operationId: string;
  name: string;
  slug: string;
  moduleIds: string[];
}

export interface TenantOnboardingAckEvent extends BaseEvent {
  eventType: 'TenantOnboardingAck';
  operationId: string;
  service: string;
  acknowledgedAt: string;
}

export interface TenantOnboardingFailedEvent extends BaseEvent {
  eventType: 'TenantOnboardingFailed';
  operationId: string;
  service: string;
  error: string;
}

/**
 * Tenant Provisioned Event
 * Published after tenant schema, RLS, auth setup, billing request, audit, and
 * activation have all completed. TenantCreated remains a final compatibility
 * alias for legacy consumers.
 */
export interface TenantProvisionedEvent extends BaseEvent {
  eventType: 'TenantProvisioned';
  operationId: string;
  name: string;
  slug: string;
}

/**
 * Tenant Updated Event
 * Published when tenant information is modified
 */
export interface TenantUpdatedEvent extends BaseEvent {
  eventType: 'TenantUpdated';
  name?: string;
  plan?: string;
  status?: string;
  maxUsers?: number;
}

/**
 * Tenant Status Changed Event
 * Published when a tenant's status changes (activated, suspended, deactivated, etc.)
 * Use this event for ALL status transitions. Status-specific consumers
 * can filter by `newStatus` value.
 */
export interface TenantStatusChangedEvent extends BaseEvent {
  eventType: 'TenantStatusChanged';
  // Typed with the canonical TenantStatus (MT-HIGH-003) — was bare `string`,
  // which let a publisher emit any value. Both publishers (auth tenant.service,
  // admin lifecycle handlers) already pass TenantStatus members.
  previousStatus: TenantStatus;
  newStatus: TenantStatus;
  reason?: string;
}

/**
 * Tenant Suspended Event
 * Published when a tenant is suspended
 */
export interface TenantSuspendedEvent extends BaseEvent {
  eventType: 'TenantSuspended';
  reason?: string;
  suspendedBy?: string;
}

/**
 * Tenant Activated Event
 * Published when a suspended tenant is re-activated
 */
export interface TenantActivatedEvent extends BaseEvent {
  eventType: 'TenantActivated';
  activatedBy?: string;
}

/**
 * Tenant Archived Event
 * Published when a tenant is archived
 */
export interface TenantArchivedEvent extends BaseEvent {
  eventType: 'TenantArchived';
  archivedBy?: string;
}

/**
 * Tenant Erasure Requested Event
 *
 * Published by the platform erasure orchestrator after legal-hold
 * precedence has been checked and the tenant-erasure run has been
 * durably accepted. Target services consume this event and return
 * service-scoped proof events; they do not publish the final proof.
 */
export interface TenantErasureRequestedEvent extends BaseEvent {
  eventType: 'TenantErasureRequested';
  operationId: string;
  requestedBy: string;
  requestedAt: string;
  legalHoldCheckedAt: string;
  dryRun: boolean;
  targetServiceCount: number;
}

/**
 * Service-scoped proof that one target completed its tenant erasure.
 */
export interface TenantDataErasedEvent extends BaseEvent {
  eventType: 'TenantDataErased';
  operationId: string;
  targetService: TenantErasureTargetService;
  erasedAt: string;
  dryRun: boolean;
  matchedRecordCount: number;
  erasedRecordCount: number;
  proofHash: string;
}

/**
 * Service-scoped failure proof. The orchestrator records this and
 * withholds the final TenantErased proof until all targets succeed.
 */
export interface TenantDataErasureFailedEvent extends BaseEvent {
  eventType: 'TenantDataErasureFailed';
  operationId: string;
  targetService: TenantErasureTargetService;
  failedAt: string;
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
}

/**
 * Durable block proof for legal-hold or policy denial.
 */
export interface TenantErasureBlockedEvent extends BaseEvent {
  eventType: 'TenantErasureBlocked';
  operationId: string;
  blockedAt: string;
  blockedByService: TenantErasureTargetService | 'platform-orchestrator';
  reason: string;
  legalMatterId?: string;
}

/**
 * Tenant Erased Event
 *
 * Final hash-signed proof emitted only by the platform erasure
 * orchestrator after every target in TENANT_ERASURE_TARGET_SERVICES
 * has returned durable TenantDataErased proof and db-migrate has
 * committed tenant schema deletion evidence. This event is not a cascade
 * trigger.
 */
export interface TenantErasedEvent extends BaseEvent {
  eventType: 'TenantErased';
  operationId: string;
  requestedAt: string;
  requestedBy: string;
  legalHoldCheckedAt: string;
  completedAt: string;
  targetServiceCount: number;
  proofHash: string;
  proofVersion: number;
}

/**
 * Snapshot of a provisioning step for failure diagnostics.
 * Captures which step failed and which succeeded during tenant provisioning.
 */
export interface ProvisioningStepSnapshot {
  /** Step name (e.g., 'createSchema', 'seedAdmin', 'configureDefaults') */
  name: string;
  /** Whether this step completed successfully */
  success: boolean;
  /** Duration of this step in milliseconds */
  durationMs?: number;
  /** Error message if this step failed */
  error?: string;
}

/**
 * Tenant Provisioning Failed Event
 * Published when tenant provisioning (schema creation, admin setup) fails.
 *
 * Flat-object pattern: individual step statuses represented as flat fields.
 * Consumers use stepCount + failedStepName + failedStepError for triage.
 */
export interface TenantProvisioningFailedEvent extends BaseEvent {
  eventType: 'TenantProvisioningFailed';
  /** Human-readable error message */
  error?: string;
  /** Total number of provisioning steps attempted */
  stepCount?: number;
  /** Total provisioning duration in milliseconds */
  durationMs?: number;
  /** Name of the step that failed (e.g., 'schema_creation', 'admin_setup') */
  failedStepName?: string;
  /** Error message from the failed step */
  failedStepError?: string;
  /** Index (0-based) of the failed step in the provisioning sequence */
  failedStepIndex?: number;
  /** Number of steps that completed successfully before failure */
  completedStepCount?: number;
}

/**
 * Tenant Subscription Changed Event
 */
export interface TenantSubscriptionChangedEvent extends BaseEvent {
  eventType: 'TenantSubscriptionChanged';
  previousPlan: string;
  newPlan: string;
  effectiveDate: Date;
  /**
   * DATA-LOW-001: the full subscription-projection state billing emits so
   * auth.tenants can mirror it (billing.subscriptions is the SSoT). Optional +
   * additive — older producers that only set previousPlan/newPlan/effectiveDate
   * stay valid, and the auth projection skips any field left undefined.
   */
  trialEndsAt?: Date | null;
  subscriptionEndsAt?: Date | null;
  /** Subscription lifecycle status (e.g. 'trial' | 'active' | 'cancelled' | 'expired'). */
  subscriptionStatus?: string;
}

/**
 * Module quantity configuration for pricing
 */
export interface ModuleQuantityConfig {
  moduleId: string;
  users?: number;
  farms?: number;
  ponds?: number;
  sensors?: number;
  employees?: number;
  devices?: number;
  storageGb?: number;
  apiCalls?: number;
  alerts?: number;
  reports?: number;
  integrations?: number;
}

/**
 * Tenant Subscription Requested Event
 * Published when a new tenant needs subscription created.
 * The billing service should listen to this event and create the subscription.
 */
export interface TenantSubscriptionRequestedEvent extends BaseEvent {
  eventType: 'TenantSubscriptionRequested';
  /** Tenant's name for display purposes */
  tenantName: string;
  /** Module IDs to include in subscription */
  moduleIds: string[];
  /** Optional quantity configuration per module */
  moduleQuantities?: ModuleQuantityConfig[];
  /** Trial period in days (if applicable) */
  trialDays?: number;
  /** Plan tier */
  tier: PlanTier;
  /** Billing cycle */
  billingCycle: BillingCycle;
  /** Billing email address */
  billingEmail?: string;
  /** User who created the tenant */
  createdBy: string;
}

/**
 * Tenant Modules Assigned Event
 * Published when modules are bulk-assigned to a tenant with pricing
 */
export interface TenantModulesAssignedEvent extends BaseEvent {
  eventType: 'TenantModulesAssigned';
  /** Module IDs that were assigned */
  moduleIds: string[];
  /** Module codes for consumers that need codes rather than IDs */
  moduleCodes?: string[];
  /** Monthly pricing total (flat-object: promoted from nested pricing object) */
  pricingMonthlyTotal?: number;
  /** Annual pricing total */
  pricingAnnualTotal?: number;
  /** Pricing tier (e.g., 'starter', 'professional', 'enterprise') */
  pricingTier?: string;
  /** Pricing currency code (e.g., 'USD', 'EUR', 'TRY') */
  pricingCurrency?: string;
  /** User who assigned the modules */
  assignedBy: string;
}

/**
 * Module Removed From Tenant Event
 * Published when a module is removed from a tenant
 */
export interface ModuleRemovedFromTenantEvent extends BaseEvent {
  eventType: 'ModuleRemovedFromTenant';
  /** Module ID that was removed */
  moduleId: string;
  /** User who removed the module */
  removedBy: string;
}

// ==================== Type Union ====================

/**
 * Union type for all tenant events
 */
export type TenantEvent =
  | TenantCreatedEvent
  | TenantProvisioningRequestedEvent
  | TenantOnboardingRequestedEvent
  | TenantOnboardingAckEvent
  | TenantOnboardingFailedEvent
  | TenantProvisionedEvent
  | TenantUpdatedEvent
  | TenantStatusChangedEvent
  | TenantSuspendedEvent
  | TenantActivatedEvent
  | TenantArchivedEvent
  | TenantErasureRequestedEvent
  | TenantDataErasedEvent
  | TenantDataErasureFailedEvent
  | TenantErasureBlockedEvent
  | TenantErasedEvent
  | TenantProvisioningFailedEvent
  | TenantSubscriptionChangedEvent
  | TenantSubscriptionRequestedEvent
  | TenantModulesAssignedEvent
  | ModuleRemovedFromTenantEvent;
