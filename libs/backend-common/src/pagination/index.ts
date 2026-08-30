/**
 * Pagination Module
 *
 * Standard Pattern (page/limit with full metadata):
 * - Input: StandardPaginationInput (page, limit, sortBy, sortOrder)
 * - Output: StandardPaginatedResponse<T> (items, total, page, limit, totalPages, hasNextPage, hasPreviousPage)
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
  type PaginationMetadataV1,
  type PaginationResultV1,
  type StandardPaginatedResult,
  createStandardPaginatedResult,
  hasUnissuedPaginationShapeV1,
  isStandardPaginatedResult,
  paginationMetadataV1,
  fromCqrsPaginated,
  safeSortField,
  safeSortOrder,
} from './pagination.dto';

// Cursor pagination primitive — phase 5.1. Opaque-cursor
// forward-traversal pagination for hot paths that outgrow
// offset/limit. Resolvers migrate at their own pace behind a
// parallel API while page/limit consumers remain on the canonical
// StandardPaginationInput contract.
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
export { paginateCursor, type PaginateCursorOptions } from './cursor-repository';
