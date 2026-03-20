/**
 * Pagination Module
 *
 * Standard Pattern (page/limit with full metadata):
 * - Input: StandardPaginationInput (page, limit, sortBy, sortOrder)
 * - Output: StandardPaginatedResponse<T> (items, total, page, limit, totalPages, hasNextPage, hasPreviousPage)
 *
 * Legacy Pattern (offset/limit with hasMore) — @deprecated, Phase 3 removal:
 * - Input: PaginationInput
 * - Output: PaginatedResponse<T>
 *
 * @module Pagination
 */
export {
  // Enum
  SortOrder,
  // Standard (use these)
  StandardPaginationInput,
  StandardPaginatedResponse,
  IStandardPaginatedResult,
  createStandardPaginatedResult,
  fromCqrsPaginated,
  safeSortField,
  safeSortOrder,
  // Legacy (deprecated — Phase 3 removal)
  PaginationInput,
  PaginatedResponse,
  IPaginatedResult,
  calculateHasMore,
  createPaginatedResult,
} from './pagination.dto';
