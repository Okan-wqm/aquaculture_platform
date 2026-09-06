/** Versioned, browser- and server-neutral pagination authority. */
export interface PaginationResultV1<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly limit: number;
  readonly totalPages: number;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
}

export type StandardPaginatedResult<T> = PaginationResultV1<T>;

/** Pagination coordinates shared by server results and REST response metadata. */
export type PaginationMetadataV1 = Omit<PaginationResultV1<never>, 'items'>;

/** Browser-facing projection after the REST envelope has been decoded. */
export type PaginatedDataResultV1<T> = PaginationMetadataV1 & {
  readonly data: readonly T[];
};

/**
 * Cursor pagination is a different protocol from page/limit pagination.
 * Keeping it explicit prevents consumers from fabricating page coordinates
 * for APIs whose only stable continuation coordinate is an opaque cursor.
 */
export interface CursorPaginationResultV1<T> {
  readonly items: readonly T[];
  readonly totalCount: number;
  readonly hasMore: boolean;
  readonly cursor: string | null;
}

export class PaginationContractError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`pagination.${field}: ${message}`);
    this.name = 'PaginationContractError';
  }
}

const issuedResults = new WeakSet<object>();
const issuedCursorResults = new WeakSet<object>();

function assertSafeInteger(value: number, field: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new PaginationContractError(
      field,
      `expected a safe integer greater than or equal to ${minimum}`,
    );
  }
}

export function expectedTotalPages(total: number, limit: number): number {
  assertSafeInteger(total, 'total', 0);
  assertSafeInteger(limit, 'limit', 1);
  return Math.max(1, Math.ceil(total / limit));
}

export function derivePaginationMetadataV1(
  total: number,
  page: number,
  limit: number,
): PaginationMetadataV1 {
  assertSafeInteger(total, 'total', 0);
  assertSafeInteger(page, 'page', 1);
  assertSafeInteger(limit, 'limit', 1);
  const totalPages = expectedTotalPages(total, limit);
  return Object.freeze({
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  });
}

export function createStandardPaginatedResult<T>(
  items: readonly T[],
  total: number,
  page: number,
  limit: number,
): PaginationResultV1<T> {
  const metadata = derivePaginationMetadataV1(total, page, limit);

  if (items.length > limit) {
    throw new PaginationContractError(
      'items',
      `contains ${items.length} entries, above limit ${limit}`,
    );
  }
  if (items.length > total) {
    throw new PaginationContractError(
      'items',
      `contains ${items.length} entries, above total ${total}`,
    );
  }

  // Concurrent deletes or a narrowed filter can make a requested page stale.
  // Preserve that coordinate as an honest empty page, while rejecting data
  // that claims to exist beyond the derived final page.
  if (page > metadata.totalPages && items.length > 0) {
    throw new PaginationContractError(
      'page',
      `non-empty page exceeds totalPages ${metadata.totalPages}`,
    );
  }

  const result: PaginationResultV1<T> = Object.freeze({
    items: Object.freeze([...items]),
    ...metadata,
  });
  issuedResults.add(result);
  return result;
}

/**
 * Recognises only values minted by createStandardPaginatedResult.
 * A structurally similar object cannot silently become a wire-level page.
 */
export function isStandardPaginatedResult(value: unknown): value is PaginationResultV1<unknown> {
  return typeof value === 'object' && value !== null && issuedResults.has(value);
}

/**
 * Detects values that claim pagination coordinates without having been issued
 * by the canonical factory. Transport boundaries use this to fail closed
 * instead of silently nesting a legacy or hand-written page in a plain result.
 */
export function hasUnissuedPaginationShapeV1(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    'total' in candidate &&
    'page' in candidate &&
    'limit' in candidate &&
    ('items' in candidate || 'data' in candidate)
  );
}

export function paginationMetadataV1(result: PaginationResultV1<unknown>): PaginationMetadataV1 {
  if (!isStandardPaginatedResult(result)) {
    throw new PaginationContractError('authority', 'expected a factory-issued result');
  }
  return derivePaginationMetadataV1(result.total, result.page, result.limit);
}

export function createPaginatedDataResultV1<T>(
  data: readonly T[],
  total: number,
  page: number,
  limit: number,
): PaginatedDataResultV1<T> {
  const result = createStandardPaginatedResult(data, total, page, limit);
  return Object.freeze({ data: result.items, ...paginationMetadataV1(result) });
}

export function createCursorPaginationResultV1<T>(
  items: readonly T[],
  totalCount: number,
  hasMore: boolean,
  cursor: string | null,
): CursorPaginationResultV1<T> {
  assertSafeInteger(totalCount, 'totalCount', 0);
  if (items.length > totalCount) {
    throw new PaginationContractError(
      'items',
      `contains ${items.length} entries, above totalCount ${totalCount}`,
    );
  }
  if (hasMore !== (cursor !== null)) {
    throw new PaginationContractError('cursor', 'must be present exactly when hasMore is true');
  }
  if (cursor !== null && cursor.length === 0) {
    throw new PaginationContractError('cursor', 'must be a non-empty opaque value');
  }

  const result: CursorPaginationResultV1<T> = Object.freeze({
    items: Object.freeze([...items]),
    totalCount,
    hasMore,
    cursor,
  });
  issuedCursorResults.add(result);
  return result;
}

export function isCursorPaginationResultV1(
  value: unknown,
): value is CursorPaginationResultV1<unknown> {
  return typeof value === 'object' && value !== null && issuedCursorResults.has(value);
}

/**
 * Validates pagination metadata received across a serialization boundary.
 * Redundant fields must agree with the canonical derivation.
 */
export function isPaginationMetadataV1(value: unknown): value is PaginationMetadataV1 {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const metadata = value as Record<string, unknown>;
  const { total, page, limit, totalPages, hasNextPage, hasPreviousPage } = metadata;
  if (
    typeof total !== 'number' ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    typeof page !== 'number' ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    typeof totalPages !== 'number' ||
    !Number.isSafeInteger(totalPages) ||
    typeof hasNextPage !== 'boolean' ||
    typeof hasPreviousPage !== 'boolean'
  ) {
    return false;
  }

  const derived = derivePaginationMetadataV1(total, page, limit);
  return (
    totalPages === derived.totalPages &&
    hasNextPage === derived.hasNextPage &&
    hasPreviousPage === derived.hasPreviousPage
  );
}
