/** Browser- and server-neutral pagination authority. */
export interface StandardPaginatedResult<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly limit: number;
  readonly totalPages: number;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
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

export function createStandardPaginatedResult<T>(
  items: readonly T[],
  total: number,
  page: number,
  limit: number,
): StandardPaginatedResult<T> {
  assertSafeInteger(total, 'total', 0);
  assertSafeInteger(page, 'page', 1);
  assertSafeInteger(limit, 'limit', 1);
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
  const totalPages = expectedTotalPages(total, limit);
  // A client can legitimately request a page that became stale after a
  // concurrent delete or after a filter narrows the result set.  Preserve the
  // requested coordinate and represent that state as an honest empty page.
  // Non-empty data beyond the derived final page is impossible and remains a
  // fail-closed contract violation.
  if (page > totalPages && items.length > 0) {
    throw new PaginationContractError(
      'page',
      `non-empty page exceeds totalPages ${totalPages}`,
    );
  }
  return Object.freeze({
    items: Object.freeze([...items]),
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  });
}
