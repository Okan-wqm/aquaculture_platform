/**
 * Common/shared types used across multiple domain APIs
 */

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

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
