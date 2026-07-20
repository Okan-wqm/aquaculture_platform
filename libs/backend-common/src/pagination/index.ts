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
  // I*Result are interfaces — inline `type` modifier under
  // isolatedModules. Same pattern used below for cursor / cursor-
  // repository exports.
  type IStandardPaginatedResult,
  createStandardPaginatedResult,
  isStandardPaginatedResult,
  fromCqrsPaginated,
  safeSortField,
  safeSortOrder,
  // Legacy (deprecated — Phase 4 complete, remove in Phase 5)
  PaginationInput,
  PaginatedResponse,
  type IPaginatedResult,
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

// TypeORM adapter — the one-line bridge from Repository<T> to
// CursorPaginatedResponse<T>. Keeps per-resolver adoption
// boilerplate-free so the tuple WHERE clause stays in one
// place platform-wide.
export {
  paginateCursor,
  type PaginateCursorOptions,
} from './cursor-repository';
