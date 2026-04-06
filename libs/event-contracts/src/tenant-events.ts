import { BaseEvent, PlanTier, BillingCycle } from './base-event';

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
  previousStatus: string;
  newStatus: string;
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
 * ARCH-C01: steps serialized as JSON string — array of complex objects
 * with variable structure makes flat-field mapping impractical.
 * stepCount provides quick access without deserializing.
 */
export interface TenantProvisioningFailedEvent extends BaseEvent {
  eventType: 'TenantProvisioningFailed';
  error?: string;
  stepsJson?: string;
  stepCount?: number;
  duration?: number;
}

/**
 * Tenant Subscription Changed Event
 */
export interface TenantSubscriptionChangedEvent extends BaseEvent {
  eventType: 'TenantSubscriptionChanged';
  previousPlan: string;
  newPlan: string;
  effectiveDate: Date;
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
  /** Pricing information if calculated */
  pricing?: {
    monthlyTotal: number;
    annualTotal: number;
    tier: string;
    currency: string;
  };
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
  | TenantUpdatedEvent
  | TenantStatusChangedEvent
  | TenantSuspendedEvent
  | TenantActivatedEvent
  | TenantArchivedEvent
  | TenantProvisioningFailedEvent
  | TenantSubscriptionChangedEvent
  | TenantSubscriptionRequestedEvent
  | TenantModulesAssignedEvent
  | ModuleRemovedFromTenantEvent;
