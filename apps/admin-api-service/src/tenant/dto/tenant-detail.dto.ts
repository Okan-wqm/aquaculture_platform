import { IsArray, IsUUID, ArrayMaxSize, IsString, IsOptional, IsBoolean, MaxLength, IsEnum } from 'class-validator';

import { TenantActivity, TenantNote, TenantBillingInfo } from '../entities/tenant-activity.entity';
import { Tenant, TenantPlan } from '../entities/tenant.entity';

import { TenantLimitsDto } from './tenant.dto';

export type TenantAvailableAction =
  | 'activate'
  | 'suspend'
  | 'deactivate'
  | 'archive'
  | 'retryProvisioning';

// User Statistics by Role
export interface UserStatsByRole {
  total: number;
  active: number;
  inactive: number;
  byRole: {
    admin: number;
    manager: number;
    supervisor: number;
    operator: number;
    viewer: number;
  };
  recentlyActive: number; // last 7 days
  newUsersLast30Days: number;
}

// Module Usage Statistics
export interface ModuleUsageStats {
  moduleId: string;
  moduleCode: string;
  moduleName: string;
  isActive: boolean;
  assignedAt: Date;
  usageCount?: number;
  lastUsedAt?: Date;
}

// Storage & API Usage
export interface ResourceUsage {
  storage: {
    usedGb: number;
    limitGb: number;
    percentage: number;
  };
  users: {
    count: number;
    limit: number;
    percentage: number;
  };
  farms: {
    count: number;
    limit: number;
    percentage: number;
  };
  sensors: {
    count: number;
    limit: number;
    percentage: number;
  };
  apiCalls: {
    last24h: number;
    last7d: number;
    limit: number;
  };
}

// Billing Summary
export interface BillingSummary {
  currentPlan: TenantPlan;
  monthlyAmount: number;
  currency: string;
  billingCycle: string;
  paymentStatus: string;
  nextBillingDate: Date | null;
  lastPaymentDate: Date | null;
  lastPaymentAmount: number | null;
}

// Full Tenant Detail Response
export interface TenantDetailDto {
  // Basic Info
  id: string;
  name: string;
  slug: string;
  description?: string;
  domain?: string;

  // Status & Tier
  status: string;
  tier: TenantPlan;
  plan?: string;
  trialEndsAt?: Date;
  // Suspension audit (DB-ADMIN-HIGH-003): real auth.tenants columns written
  // only by auth-service; NULL when the tenant is not suspended.
  suspendedAt?: Date | null;
  suspendedReason?: string | null;
  availableActions: TenantAvailableAction[];

  // Contact Info
  primaryContact?: {
    name: string;
    email: string;
    phone?: string;
    role: string;
  };
  billingContact?: {
    name: string;
    email: string;
    phone?: string;
    role: string;
  };
  billingEmail?: string;

  // Location
  country?: string;
  region?: string;

  // Settings & Limits
  settings?: {
    timezone: string;
    locale: string;
    currency: string;
    dateFormat: string;
    measurementSystem: string;
    notificationPreferences: {
      email: boolean;
      sms: boolean;
      push: boolean;
      slack: boolean;
    };
    features: string[];
  };
  limits?: TenantLimitsDto;
  userCount: number;
  farmCount: number;
  sensorCount: number;
  maxStorage: number;
  isTrialActive: boolean;

  // Statistics
  userStats?: UserStatsByRole;
  resourceUsage?: ResourceUsage;

  // Modules
  modules?: ModuleUsageStats[];

  // Activity & Notes
  recentActivities?: TenantActivity[];
  notes?: TenantNote[];

  // Billing
  billing?: BillingSummary;

  // Metadata
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  // NOTE: lastActivityAt was removed (DB-ADMIN-HIGH-003 cleanup): no
  // auth.tenants column ever backed it, so the field was always undefined.
  // Tenant activity lives in recentActivities (admin.tenant_activities).
}

// Tenant List Item (optimized for list view)
export interface TenantListItemDto {
  id: string;
  name: string;
  slug: string;
  domain?: string;
  status: string;
  tier: TenantPlan;
  contactEmail?: string;
  userCount: number;
  farmCount: number;
  sensorCount: number;
  activeModulesCount?: number;
  // NOTE: lastActivityAt was removed (DB-ADMIN-HIGH-003 cleanup): the list
  // mapper never populated it and no auth.tenants column backed it.
  createdAt: Date;
}

// Note categories allowed for tenant notes (HIGH-003 fix)
const ALLOWED_NOTE_CATEGORIES = ['general', 'billing', 'support', 'compliance', 'technical'] as const;
type NoteCategory = typeof ALLOWED_NOTE_CATEGORIES[number];

// HIGH-003 fix: typed DTO with validation decorators to prevent oversized/malicious note content
export class CreateTenantNoteDto {
  @IsString()
  @MaxLength(5000)
  content!: string;

  @IsOptional()
  @IsEnum(ALLOWED_NOTE_CATEGORIES)
  category?: NoteCategory;

  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;
}

export class UpdateTenantNoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  content?: string;

  @IsOptional()
  @IsEnum(ALLOWED_NOTE_CATEGORIES)
  category?: NoteCategory;

  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;
}

// Bulk Operation DTOs

// HIGH-005 fix: typed class with ArrayMaxSize and per-element UUID validation
export class BulkSuspendDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  tenantIds!: string[];

  @IsString()
  @MaxLength(500)
  reason!: string;
}

// BUG-024 fix: typed DTO with class-validator so tenantIds receives UUID format
// validation and size limits — preventing DoS from oversized arrays.
export class BulkActivateDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  tenantIds!: string[];
}

export interface BulkAssignModulesDto {
  tenantIds: string[];
  moduleIds: string[];
}

export interface BulkNotificationDto {
  tenantIds: string[];
  subject: string;
  message: string;
  notificationType: 'email' | 'in_app' | 'both';
}
