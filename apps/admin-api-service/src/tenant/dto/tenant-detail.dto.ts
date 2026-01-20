import { TenantLimitsDto } from './tenant.dto';
import { TenantActivity, TenantNote, TenantBillingInfo } from '../entities/tenant-activity.entity';
import { Tenant } from '../entities/tenant.entity';

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
  currentPlan: string;
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
  tier: string;
  trialEndsAt?: Date;
  suspendedAt?: Date;
  suspendedReason?: string;

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
  lastActivityAt?: Date;
}

// Tenant List Item (optimized for list view)
export interface TenantListItemDto {
  id: string;
  name: string;
  slug: string;
  domain?: string;
  status: string;
  tier: string;
  contactEmail?: string;
  userCount: number;
  farmCount: number;
  sensorCount: number;
  activeModulesCount?: number;
  lastActivityAt?: Date;
  createdAt: Date;
}

// Bulk Operation DTOs
export interface BulkSuspendDto {
  tenantIds: string[];
  reason: string;
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
