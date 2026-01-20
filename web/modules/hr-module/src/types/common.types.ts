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
  version: number;
  isDeleted: boolean;
}

/** Pagination input */
export interface PaginationInput {
  limit?: number;
  offset?: number;
}

/** Paginated response wrapper */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

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
