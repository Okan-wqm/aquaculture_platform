/**
 * Tenant domain types
 */

// ============================================================================
// Tenant Enums (Backend uyumlu)
// ============================================================================

export enum TenantStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  DEACTIVATED = 'deactivated',
  ARCHIVED = 'archived',
}

export enum TenantTier {
  FREE = 'free',
  STARTER = 'starter',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
  CUSTOM = 'custom',
}

// ============================================================================
// Tenant Interfaces
// ============================================================================

export interface TenantLimits {
  maxUsers: number;
  maxFarms: number;
  maxPonds: number;
  maxSensors: number;
  maxAlertRules: number;
  dataRetentionDays: number;
  apiRateLimit: number;
  storageGb: number;
}

export interface TenantSettings {
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
}

export interface TenantContact {
  name: string;
  email: string;
  phone?: string;
  role: string;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  description?: string;
  domain?: string;
  tier: TenantTier;
  status: TenantStatus;
  userCount: number;
  farmCount: number;
  sensorCount: number;
  limits?: TenantLimits;
  settings?: TenantSettings;
  primaryContact?: TenantContact;
  billingContact?: TenantContact;
  billingEmail?: string;
  country?: string;
  region?: string;
  trialEndsAt?: string;
  suspendedAt?: string;
  suspendedReason?: string;
  suspendedBy?: string;
  lastActivityAt?: string;
  createdBy?: string;
  maxStorage?: number;
  isTrialActive?: boolean;
  createdAt: string;
  updatedAt: string;
  version?: number;
}

export interface TenantStats {
  total: number;
  active: number;
  suspended: number;
  pending: number;
  byTier: Record<TenantTier, number>;
}

export interface TenantActivity {
  id: string;
  tenantId: string;
  activityType: string;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
  previousValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  performedBy?: string;
  performedByEmail?: string;
  createdAt: string;
}

export interface TenantNote {
  id: string;
  tenantId: string;
  content: string;
  category: string;
  isPinned: boolean;
  createdBy: string;
  createdByEmail?: string;
  createdAt: string;
}

export interface TenantDetail extends Tenant {
  userStats?: {
    total: number;
    active: number;
    inactive: number;
    byRole: Record<string, number>;
    recentlyActive: number;
    newUsersLast30Days: number;
  };
  resourceUsage?: {
    storage: { usedGb: number; limitGb: number; percentage: number };
    users: { count: number; limit: number; percentage: number };
    farms: { count: number; limit: number; percentage: number };
    sensors: { count: number; limit: number; percentage: number };
    apiCalls: { last24h: number; last7d: number; limit: number };
  };
  modules?: Array<{
    moduleId: string;
    moduleCode: string;
    moduleName: string;
    isActive: boolean;
    assignedAt: string;
  }>;
  recentActivities?: TenantActivity[];
  notes?: TenantNote[];
  billing?: {
    currentPlan: string;
    monthlyAmount: number;
    currency: string;
    billingCycle: string;
    paymentStatus: string;
    nextBillingDate: string | null;
    lastPaymentDate: string | null;
    lastPaymentAmount: number | null;
  };
}

/**
 * Module quantity configuration for pricing calculation
 */
export interface ModuleQuantityConfig {
  moduleId: string;
  users?: number;
  farms?: number;
  ponds?: number;
  sensors?: number;
  employees?: number;
}

export interface CreateTenantDto {
  name: string;
  slug?: string;
  tier?: TenantTier;
  description?: string;
  domain?: string;
  primaryContact?: TenantContact;
  billingContact?: TenantContact;
  billingEmail?: string;
  country?: string;
  region?: string;
  trialDays?: number;
  maxUsers?: number;
  maxStorage?: number;
  limits?: Partial<TenantLimits>;
  settings?: Partial<TenantSettings>;
  /**
   * Module IDs to assign to the tenant during creation
   * Super Admin selects which modules the tenant will have access to
   */
  moduleIds?: string[];
  /**
   * Optional quantity configuration per module for pricing calculation
   */
  moduleQuantities?: ModuleQuantityConfig[];
  /**
   * Billing cycle preference: monthly, quarterly, semi_annual, annual
   */
  billingCycle?: 'monthly' | 'quarterly' | 'semi_annual' | 'annual';
}

export interface UpdateTenantDto {
  name?: string;
  description?: string;
  domain?: string;
  tier?: TenantTier;
  primaryContact?: TenantContact;
  billingContact?: TenantContact;
  billingEmail?: string;
  country?: string;
  region?: string;
  limits?: Partial<TenantLimits>;
  settings?: Partial<TenantSettings>;
}
