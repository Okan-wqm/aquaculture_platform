import type { PaginationResultV1 } from '@platform/pagination-contracts';

/**
 * Common types shared across HR module
 */

/** Base entity with common audit fields */
export interface BaseEntity {
  id: string;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
  version?: number;
  isDeleted: boolean;
}

/**
 * @deprecated Use `StandardPaginationInput` from '@aquaculture/shared-ui' instead.
 */
export type PaginationInput = { limit?: number; page?: number };

/**
 * The page contract, held rather than restated.
 *
 * ADMIN-HIGH-004: this used to be a hand-written interface that happened to
 * agree with the backend today and had no way of noticing when it stopped.
 * It IS the versioned authority type now.
 */
export type PaginatedResponse<T> = PaginationResultV1<T>;

// Re-export standard types for incremental migration
export type { StandardPaginationInput, StandardPaginatedResult } from '@aquaculture/shared-ui';

/** Date range filter */
export interface DateRangeFilter {
  startDate?: string;
  endDate?: string;
}

/** Geo location */
export interface GeoLocation {
  latitude: number;
  longitude: number;
  address?: string;
  accuracy?: number;
}

/** Generic select option */
export interface SelectOption<T = string> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
}

/** Status badge variant */
export type BadgeVariant =
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'default'
  | 'primary';

/** Status configuration for UI */
export interface StatusConfig {
  label: string;
  variant: BadgeVariant;
  icon?: string;
}
