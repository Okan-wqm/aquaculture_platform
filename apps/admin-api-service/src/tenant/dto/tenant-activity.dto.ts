import type { TenantNote } from '../entities/tenant-activity.entity';

/** Closed vocabulary shared by persistence and the tenant activity wire DTO. */
export enum ActivityType {
  CREATED = 'created',
  ACTIVATED = 'activated',
  SUSPENDED = 'suspended',
  DEACTIVATED = 'deactivated',
  PLAN_CHANGED = 'plan_changed',
  LIMITS_UPDATED = 'limits_updated',
  MODULE_ASSIGNED = 'module_assigned',
  MODULE_REMOVED = 'module_removed',
  USER_ADDED = 'user_added',
  USER_REMOVED = 'user_removed',
  SETTINGS_UPDATED = 'settings_updated',
  PAYMENT_RECEIVED = 'payment_received',
  PAYMENT_FAILED = 'payment_failed',
  TRIAL_STARTED = 'trial_started',
  TRIAL_EXPIRED = 'trial_expired',
  CONTACT_UPDATED = 'contact_updated',
  DOMAIN_CHANGED = 'domain_changed',
}

export interface TenantActivityDto {
  id: string;
  tenantId: string;
  activityType: ActivityType;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
  previousValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  performedBy?: string;
  performedByEmail?: string;
  createdAt: Date;
}

export interface TenantNoteDto {
  id: string;
  tenantId: string;
  content: string;
  category: string;
  isPinned: boolean;
  createdBy: string;
  createdByEmail?: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toTenantNoteDto(note: TenantNote): TenantNoteDto {
  return {
    id: note.id,
    tenantId: note.tenantId,
    content: note.content,
    category: note.category,
    isPinned: note.isPinned,
    createdBy: note.createdBy,
    createdByEmail: note.createdByEmail,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}
