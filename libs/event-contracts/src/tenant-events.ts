import { BaseEvent } from './base-event';

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
 * Published when a tenant's status changes (activated, suspended, cancelled)
 */
export interface TenantStatusChangedEvent extends BaseEvent {
  eventType: 'TenantStatusChanged';
  previousStatus: string;
  newStatus: string;
  reason?: string;
}

/**
 * Tenant Deactivated Event
 * Published when a tenant is deactivated
 */
export interface TenantDeactivatedEvent extends BaseEvent {
  eventType: 'TenantDeactivated';
  reason?: string;
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
 * Tenant Module Assigned Event
 * Published when modules are assigned to a tenant
 */
export interface TenantModuleAssignedEvent extends BaseEvent {
  eventType: 'TenantModuleAssigned';
  moduleCodes: string[];
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
 * Published when a new tenant needs subscription created
 * The billing service should listen to this event and create the subscription
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
  /** Plan tier: starter, professional, enterprise */
  tier: string;
  /** Billing cycle: monthly, quarterly, semi_annual, annual */
  billingCycle: string;
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
