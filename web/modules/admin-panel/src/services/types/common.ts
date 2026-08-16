/**
 * Common/shared types used across multiple domain APIs
 */

export type { StandardPaginatedResult } from '@platform/admin-http-contracts';

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
