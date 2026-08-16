/**
 * Canonical tenant read projection.
 *
 * TypeORM entities are persistence records, not HTTP contracts. In particular,
 * `Tenant.tier` and `Tenant.limits` are prototype getters and disappear during
 * JSON serialization. Every tenant read goes through the mappers in this file
 * so the wire receives a plain object with explicit own properties.
 */
import { TenantPlan, TenantStatus } from '../entities/tenant.entity';
import type { Tenant } from '../entities/tenant.entity';

export interface TenantSummaryDto {
  id: string;
  name: string;
  slug: string;
  domain?: string;
  status: TenantStatus;
  /** Materialized from the persisted `plan` column. */
  tier: TenantPlan;
  contactEmail?: string;
  description?: string;
  trialEndsAt: Date | null;
  isTrialActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TenantListItemDto extends TenantSummaryDto {
  userCount: number;
  farmCount: number;
  sensorCount: number;
}

export interface TenantResourceCounts {
  farmCount: number;
  sensorCount: number;
}

export type TenantPublicSummaryDto = Omit<TenantSummaryDto, 'status'>;

export interface BulkTenantOperationResult {
  success: string[];
  failed: string[];
}

export interface TenantSubscriptionReconciliation {
  tenantId: string;
  subscriptionId?: string;
  status?: string;
  moduleItemCount?: number;
  replayed?: boolean;
}

export function toTenantSummary(tenant: Tenant): TenantSummaryDto {
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    domain: tenant.customDomain,
    status: tenant.status,
    tier: tenant.plan,
    contactEmail: tenant.contactEmail,
    description: tenant.description,
    trialEndsAt: tenant.trialEndsAt ?? null,
    isTrialActive: tenant.trialEndsAt != null && tenant.trialEndsAt > new Date(),
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
  };
}

export function toTenantListItem(
  tenant: Tenant,
  resources: TenantResourceCounts,
): TenantListItemDto {
  return {
    ...toTenantSummary(tenant),
    userCount: tenant.userCount,
    farmCount: resources.farmCount,
    sensorCount: resources.sensorCount,
  };
}
