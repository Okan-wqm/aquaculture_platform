/**
 * Pagination Module
 *
 * Provides standardized pagination types and utilities for GraphQL APIs.
 *
 * Standard Pattern (offset/limit with hasMore):
 * - Input: PaginationInput (offset, limit, sortBy, sortOrder)
 * - Output: PaginatedResponse<T> (items, total, hasMore)
 *
 * @module Pagination
 */
export {
  PaginationInput,
  PaginatedResponse,
  IPaginatedResult,
  SortOrder,
  calculateHasMore,
  createPaginatedResult,
} from './pagination.dto';
