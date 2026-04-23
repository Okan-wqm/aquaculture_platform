/**
 * Pagination Module
 *
 * Standard Pattern (page/limit with full metadata):
 * - Input: StandardPaginationInput (page, limit, sortBy, sortOrder)
 * - Output: StandardPaginatedResponse<T> (items, total, page, limit, totalPages, hasNextPage, hasPreviousPage)
 *
 * Legacy Pattern (offset/limit with hasMore) — @deprecated Phase 4 complete, remove in Phase 5:
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
  // Legacy (deprecated — Phase 4 complete, remove in Phase 5)
  PaginationInput,
  PaginatedResponse,
  IPaginatedResult,
  calculateHasMore,
  createPaginatedResult,
} from './pagination.dto';

// Cursor pagination primitive — phase 5.1. Opaque-cursor
// forward-traversal pagination for hot paths that outgrow
// offset/limit. Resolvers migrate at their own pace behind a
// parallel API; the legacy StandardPaginationInput stays valid
// throughout the deprecation window.
export {
  CursorPaginationInput,
  CursorEdge,
  CursorPageInfo,
  DEFAULT_FIRST,
  DEFAULT_FIRST_CAP,
  encodeCursor,
  decodeCursor,
  buildCursorResponse,
  normaliseCursorInput,
  type CursorPayload,
  type CursorKeyedRow,
  type CursorPaginatedResponse,
} from './cursor';
