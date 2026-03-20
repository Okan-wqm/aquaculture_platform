/**
 * Pagination Module
 *
 * Provides standardized pagination types and utilities for GraphQL APIs.
 *
 * Legacy Pattern (offset/limit with hasMore):
 * - Input: PaginationInput (offset, limit, sortBy, sortOrder) — @deprecated
 * - Output: PaginatedResponse<T> (items, total, hasMore) — @deprecated
 *
 * Standard Pattern (page/limit with full metadata):
 * - Input: StandardPaginationInput (page, limit, sortBy, sortOrder)
 * - Output: StandardPaginatedResponse<T> (items, total, page, limit, totalPages, hasNextPage, hasPreviousPage)
 *
 * @module Pagination
 */
export {
  // Legacy (deprecated — Phase 3 removal)
  PaginationInput,
  PaginatedResponse,
  IPaginatedResult,
  calculateHasMore,
  createPaginatedResult,
  // Standard (Phase 1+)
  StandardPaginationInput,
  StandardPaginatedResponse,
  IStandardPaginatedResult,
  createStandardPaginatedResult,
  fromCqrsPaginated,
  safeSortField,
  safeSortOrder,
  // Shared
  SortOrder,
} from './pagination.dto';
