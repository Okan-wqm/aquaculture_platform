/**
 * Shared Pagination DTOs
 *
 * Platform-wide pagination types and utilities.
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
import { Type } from '@nestjs/common';
import { Field, Int, ObjectType, InputType, registerEnumType } from '@nestjs/graphql';
import { IsOptional, IsInt, Min, Max, IsString, IsEnum, Matches } from 'class-validator';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Sort direction enum — registered as a GraphQL enum type.
 */
export enum SortOrder {
  ASC = 'ASC',
  DESC = 'DESC',
}

registerEnumType(SortOrder, {
  name: 'SortOrder',
  description: 'Sort direction for paginated queries',
});

// ============================================================================
// LEGACY PAGINATION (deprecated — Phase 3 removal)
// ============================================================================

/**
 * @deprecated Phase 4 complete — remove in Phase 5. Use `StandardPaginationInput` instead.
 *
 * Pagination input using offset/limit pattern.
 * - offset: Number of items to skip (default: 0)
 * - limit: Maximum number of items to return (default: 20, max: 100)
 * - sortBy: Field to sort by (default: 'createdAt')
 * - sortOrder: Sort direction ASC or DESC (default: 'DESC')
 */
@InputType({ isAbstract: true })
export class PaginationInput {
  @Field(() => Int, { nullable: true, defaultValue: 0, description: 'Number of items to skip' })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;

  @Field(() => Int, {
    nullable: true,
    defaultValue: 20,
    description: 'Maximum number of items to return (max: 100)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /**
   * Field to sort by. Must be a valid identifier (alphanumeric + underscore).
   * Consumers MUST validate this against an allowlist of permitted fields
   * before using in query builders to prevent SQL injection via ORDER BY.
   */
  @Field({
    nullable: true,
    defaultValue: 'createdAt',
    description: 'Field to sort by (must be a valid column name)',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z_][a-zA-Z0-9_]*$/, {
    message: 'sortBy must be a valid field name (alphanumeric and underscore only)',
  })
  sortBy?: string;

  @Field(() => SortOrder, {
    nullable: true,
    defaultValue: SortOrder.DESC,
    description: 'Sort direction (ASC or DESC)',
  })
  @IsOptional()
  @IsEnum(SortOrder)
  sortOrder?: SortOrder;
}

/**
 * @deprecated Phase 4 complete — remove in Phase 5. Use `IStandardPaginatedResult` instead.
 */
export interface IPaginatedResult<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

/**
 * @deprecated Phase 4 complete — remove in Phase 5. Use `StandardPaginatedResponse` instead.
 */
export function PaginatedResponse<T>(classRef: Type<T>): Type<IPaginatedResult<T>> {
  @ObjectType({ isAbstract: true })
  abstract class PaginatedResponseClass implements IPaginatedResult<T> {
    @Field(() => [classRef], { description: 'Array of items' })
    items!: T[];

    @Field(() => Int, { description: 'Total count of items matching the query' })
    total!: number;

    @Field(() => Boolean, { description: 'Whether there are more items available' })
    hasMore!: boolean;
  }
  return PaginatedResponseClass as Type<IPaginatedResult<T>>;
}

/** @deprecated Phase 4 complete — remove in Phase 5. Use `createStandardPaginatedResult` instead. */
export function calculateHasMore(total: number, offset: number, limit: number): boolean {
  return offset + limit < total;
}

/** @deprecated Phase 4 complete — remove in Phase 5. Use `createStandardPaginatedResult` instead. */
export function createPaginatedResult<T>(
  items: T[],
  total: number,
  offset: number,
  limit: number,
): IPaginatedResult<T> {
  return {
    items,
    total,
    hasMore: calculateHasMore(total, offset, limit),
  };
}

// ============================================================================
// STANDARD PAGINATION (page/limit based)
// ============================================================================

/**
 * Standard pagination input — the platform-wide base class.
 *
 * All per-service pagination inputs SHOULD extend this class:
 * ```typescript
 * @InputType('FarmPaginationInput')
 * export class FarmPaginationInput extends StandardPaginationInput {}
 * ```
 *
 * Fields:
 * - page: 1-based page number (default: 1, max: 1000)
 * - limit: Items per page (default: 20, max: 100)
 * - sortBy: Field to sort by (default: 'createdAt') — regex-validated
 * - sortOrder: ASC or DESC (default: DESC) — enum-validated
 *
 * Includes a computed `offset` getter for TypeORM `skip()` compatibility.
 */
@InputType({ isAbstract: true })
export class StandardPaginationInput {
  @Field(() => Int, { nullable: true, defaultValue: 1, description: 'Page number (1-based)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  page?: number;

  @Field(() => Int, { nullable: true, defaultValue: 20, description: 'Items per page (max 100)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @Field({ nullable: true, defaultValue: 'createdAt', description: 'Sort field' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z_][a-zA-Z0-9_]*$/, { message: 'sortBy must be a valid field name' })
  sortBy?: string;

  @Field(() => SortOrder, {
    nullable: true,
    defaultValue: SortOrder.DESC,
    description: 'Sort direction',
  })
  @IsOptional()
  @IsEnum(SortOrder)
  sortOrder?: SortOrder;

  /** Computed offset for TypeORM skip() — page-to-offset bridge */
  get offset(): number {
    return ((this.page ?? 1) - 1) * (this.limit ?? 20);
  }
}

/**
 * Interface for standard paginated results (page-based).
 */
export interface IStandardPaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * Creates a typed paginated response class for GraphQL (standard page-based).
 *
 * @example
 * ```typescript
 * @ObjectType()
 * export class PaginatedBatchResponse extends StandardPaginatedResponse(Batch) {}
 * ```
 */
export function StandardPaginatedResponse<T>(classRef: Type<T>): Type<IStandardPaginatedResult<T>> {
  @ObjectType({ isAbstract: true })
  abstract class StandardPaginatedResponseClass implements IStandardPaginatedResult<T> {
    @Field(() => [classRef], { description: 'Array of items' })
    items!: T[];

    @Field(() => Int, { description: 'Total count of items matching the query' })
    total!: number;

    @Field(() => Int, { description: 'Current page number' })
    page!: number;

    @Field(() => Int, { description: 'Items per page' })
    limit!: number;

    @Field(() => Int, { description: 'Total number of pages' })
    totalPages!: number;

    @Field(() => Boolean, { description: 'Whether there is a next page' })
    hasNextPage!: boolean;

    @Field(() => Boolean, { description: 'Whether there is a previous page' })
    hasPreviousPage!: boolean;
  }
  return StandardPaginatedResponseClass as Type<IStandardPaginatedResult<T>>;
}

/**
 * Helper: create a standard paginated result from raw data.
 */
export function createStandardPaginatedResult<T>(
  items: T[],
  total: number,
  page: number,
  limit: number,
): IStandardPaginatedResult<T> {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    items,
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

/**
 * Bridge: CQRS PaginatedQueryResult → IStandardPaginatedResult.
 * Uses structural typing to avoid a hard dependency on @platform/cqrs.
 */
export function fromCqrsPaginated<T>(result: {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}): IStandardPaginatedResult<T> {
  const p = result.pagination;
  return {
    items: result.data,
    total: p.total,
    page: p.page,
    limit: p.limit,
    totalPages: p.totalPages,
    hasNextPage: p.hasNextPage,
    hasPreviousPage: p.hasPreviousPage,
  };
}

/**
 * Safe sort field allowlist enforcement.
 * Returns the requested field if it's in the allowlist, otherwise the default.
 */
export function safeSortField(
  requested: string | undefined,
  allowlist: readonly string[],
  defaultField: string,
): string {
  return requested && allowlist.includes(requested) ? requested : defaultField;
}

/**
 * Safe sort order — normalizes to 'ASC' or 'DESC'.
 */
export function safeSortOrder(requested: string | undefined): 'ASC' | 'DESC' {
  return requested?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
}

// ============================================================================
// KEYSET (CURSOR) PAGINATION
// ============================================================================

/**
 * Keyset pagination input — the platform-wide cursor-based alternative.
 *
 * Uses the last-seen ID (or composite cursor) for efficient pagination
 * that avoids the O(offset) row skip cost of OFFSET/LIMIT.
 *
 * For large datasets (e.g., sensor readings, audit logs), keyset pagination
 * is required to maintain constant query time regardless of page depth.
 *
 * @see DATA-MEDIUM-017 (cursor pagination uses OFFSET instead of keyset)
 */
@InputType({ isAbstract: true })
export class KeysetPaginationInput {
  @Field(() => Int, { nullable: true, defaultValue: 20, description: 'Items per page (max 100)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /**
   * Opaque cursor from the previous page's `nextCursor` field.
   * When null, returns the first page.
   *
   * The cursor encodes the last-seen sort key + ID, allowing the query
   * to use a WHERE clause (e.g., `WHERE (createdAt, id) < (:cursorDate, :cursorId)`)
   * instead of OFFSET.
   */
  @Field({ nullable: true, description: 'Opaque cursor from previous page (null for first page)' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @Field({ nullable: true, defaultValue: 'createdAt', description: 'Sort field' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z_][a-zA-Z0-9_]*$/, { message: 'sortBy must be a valid field name' })
  sortBy?: string;

  @Field(() => SortOrder, {
    nullable: true,
    defaultValue: SortOrder.DESC,
    description: 'Sort direction',
  })
  @IsOptional()
  @IsEnum(SortOrder)
  sortOrder?: SortOrder;
}

/**
 * Keyset pagination result — includes cursor for next page.
 */
export interface IKeysetPaginatedResult<T> {
  items: T[];
  /** Opaque cursor to pass as `cursor` in the next request. Null if no more pages. */
  nextCursor: string | null;
  /** Whether there are more items after this page. */
  hasNextPage: boolean;
}

/**
 * Encode a keyset cursor from sort value and ID.
 *
 * @param sortValue - The value of the sort field for the last item (Date or string)
 * @param id        - The ID of the last item (UUID)
 * @returns Base64-encoded cursor string
 */
export function encodeKeysetCursor(sortValue: string | Date, id: string): string {
  const val = sortValue instanceof Date ? sortValue.toISOString() : sortValue;
  return Buffer.from(JSON.stringify({ v: val, id })).toString('base64url');
}

/**
 * Decode a keyset cursor.
 *
 * @param cursor - Base64-encoded cursor string
 * @returns Decoded sort value and ID, or null if invalid
 */
export function decodeKeysetCursor(cursor: string): { v: string; id: string } | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      'v' in decoded &&
      'id' in decoded &&
      typeof decoded.v === 'string' &&
      typeof decoded.id === 'string'
    ) {
      return { v: decoded.v, id: decoded.id };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Creates a typed keyset paginated response class for GraphQL.
 */
export function KeysetPaginatedResponse<T>(classRef: Type<T>): Type<IKeysetPaginatedResult<T>> {
  @ObjectType({ isAbstract: true })
  abstract class KeysetPaginatedResponseClass implements IKeysetPaginatedResult<T> {
    @Field(() => [classRef], { description: 'Array of items' })
    items!: T[];

    @Field({ nullable: true, description: 'Cursor for the next page (null if no more pages)' })
    nextCursor!: string | null;

    @Field(() => Boolean, { description: 'Whether there are more items' })
    hasNextPage!: boolean;
  }
  return KeysetPaginatedResponseClass as Type<IKeysetPaginatedResult<T>>;
}
