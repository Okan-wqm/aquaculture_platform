/** Tenant domain facade derived from backend projection DTOs. */
import { TenantProvisioningState, TenantStatus, TenantTier } from '@platform/tenant-vocabulary';
import type {
  AdminResponseProjectionById,
  AdminResponseProjectionId,
} from './generated/admin-route-contracts';

type TenantProjectionPrefix =
  'apps/admin-api-service/src/tenant/contracts/admin-http-response.contract.ts';
type TenantProjectionId = Extract<AdminResponseProjectionId, `${TenantProjectionPrefix}#${string}`>;
type TenantProjectionName = TenantProjectionId extends `${TenantProjectionPrefix}#${infer TName}`
  ? TName
  : never;
type TenantProjection<TName extends TenantProjectionName> =
  AdminResponseProjectionById<`${TenantProjectionPrefix}#${TName}`>;

export type CreateTenantAcceptedResponse =
  TenantProjection<'TenantPublicCreateTenantAcceptedResponseDto'>;
export type BulkTenantOperationResult = TenantProjection<'TenantAdminBulkTenantOperationResultDto'>;
export type TenantActivityDto = TenantProjection<'TenantAdminTenantActivityDtoDto'>;
export type TenantDetailDto = TenantProjection<'TenantAdminTenantDetailDtoDto'>;
export type TenantLimitsDto = NonNullable<TenantDetailDto['limits']>;
export type TenantListItemDto = TenantProjection<'TenantAdminTenantListItemDtoDto'>;
export type TenantNoteDto = TenantProjection<'TenantAdminTenantNoteDtoDto'>;
export type TenantPublicSummaryDto = TenantProjection<'TenantAdminTenantPublicSummaryDtoDto'>;
export type TenantStatsDto = TenantProjection<'TenantAdminTenantStatsDtoDto'>;
export type TenantSummaryDto = TenantProjection<'TenantAdminTenantSummaryDtoDto'>;
export type TenantUsageDto = TenantProjection<'TenantAdminTenantUsageDtoDto'>;

export { TenantProvisioningState, TenantStatus, TenantTier };
export type Tenant = TenantSummaryDto;
export type TenantListItem = TenantListItemDto;
export type TenantPublicSummary = TenantPublicSummaryDto;
export type BulkTenantOperation = BulkTenantOperationResult;
export type TenantDetail = TenantDetailDto;
export type TenantStats = TenantStatsDto;
export type TenantActivity = TenantActivityDto;
export type TenantNote = TenantNoteDto;
export type TenantLimits = TenantLimitsDto;

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
  devices?: number;
  storageGb?: number;
  apiCalls?: number;
  alerts?: number;
  reports?: number;
  integrations?: number;
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
  catalogVersionId?: string;
  quoteId?: string;
  customPlanId?: string;
}

export interface TenantProvisioningStep {
  name: string;
  state: TenantProvisioningState;
  attempts: number;
  lastError?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface UpdateTenantDto {
  name?: string;
  description?: string;
  domain?: string;
  tier?: TenantDetailDto['tier'];
  primaryContact?: TenantContact;
  billingContact?: TenantContact;
  billingEmail?: string;
  country?: string;
  region?: string;
  limits?: Partial<TenantLimits>;
  settings?: Partial<TenantSettings>;
}
