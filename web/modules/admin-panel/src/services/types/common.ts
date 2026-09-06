/**
 * Common/shared types used across multiple domain APIs
 */

import type { PaginatedDataResultV1 } from '@platform/pagination-contracts';

/**
 * The decoded browser projection of a server page.
 *
 * ADMIN-HIGH-004: this used to be a local interface that agreed with neither
 * the producers (`items`) nor the envelope (which never carried
 * `hasNextPage`). It IS the authority type now, so a field added to the page
 * contract is a compile error on this tier instead of a missing key at runtime.
 */
export type PaginatedResult<T> = PaginatedDataResultV1<T>;

export interface PaginationParams {
  page?: number;
  limit?: number;
  [key: string]: unknown;
}

export interface DateRangeParams {
  startDate?: string;
  endDate?: string;
  [key: string]: unknown;
}
