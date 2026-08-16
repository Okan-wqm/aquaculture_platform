import {
  createCursorPaginationResultV1,
  createPaginatedDataResultV1,
  createStandardPaginatedResult,
  derivePaginationMetadataV1,
  expectedTotalPages,
  hasUnissuedPaginationShapeV1,
  isPaginationMetadataV1,
  isCursorPaginationResultV1,
  isStandardPaginatedResult,
  paginationMetadataV1,
  PaginationContractError,
} from './index';

describe('pagination contract authority', () => {
  it('derives every redundant field in one place', () => {
    const result = createStandardPaginatedResult(['a', 'b'], 3, 1, 2);

    expect(result).toEqual({
      items: ['a', 'b'],
      total: 3,
      page: 1,
      limit: 2,
      totalPages: 2,
      hasNextPage: true,
      hasPreviousPage: false,
    });
    expect(expectedTotalPages(0, 20)).toBe(1);
    expect(isStandardPaginatedResult(result)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
  });

  it('does not recognise a hand-written structural duplicate as authority output', () => {
    const duplicate = {
      items: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    };

    expect(isStandardPaginatedResult(duplicate)).toBe(false);
    expect(hasUnissuedPaginationShapeV1(duplicate)).toBe(true);
    expect(hasUnissuedPaginationShapeV1({ total: 1, label: 'domain-statistic' })).toBe(false);
  });

  it('accepts honest empty stale pages and rejects impossible pages', () => {
    expect(() => createStandardPaginatedResult(['a', 'b'], 1, 1, 2)).toThrow(
      PaginationContractError,
    );
    expect(createStandardPaginatedResult([], 5, 4, 2)).toEqual({
      items: [],
      total: 5,
      page: 4,
      limit: 2,
      totalPages: 3,
      hasNextPage: false,
      hasPreviousPage: true,
    });
    expect(createStandardPaginatedResult([], 0, 2, 20)).toEqual({
      items: [],
      total: 0,
      page: 2,
      limit: 20,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: true,
    });
    expect(() => createStandardPaginatedResult(['stale'], 5, 4, 2)).toThrow(
      'non-empty page exceeds totalPages 3',
    );
  });

  it('rejects unsafe numeric coordinates and oversized item sets', () => {
    expect(() => createStandardPaginatedResult([], -1, 1, 20)).toThrow(PaginationContractError);
    expect(() => createStandardPaginatedResult([], 1, 0, 20)).toThrow(PaginationContractError);
    expect(() => createStandardPaginatedResult([], 1, 1, 0)).toThrow(PaginationContractError);
    expect(() => createStandardPaginatedResult(['a', 'b'], 2, 1, 1)).toThrow('above limit 1');
  });

  it('projects and validates serialized metadata without a second derivation authority', () => {
    const result = createStandardPaginatedResult(['a'], 3, 2, 1);
    const metadata = paginationMetadataV1(result);

    expect(metadata).toEqual({
      total: 3,
      page: 2,
      limit: 1,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: true,
    });
    expect(derivePaginationMetadataV1(3, 2, 1)).toEqual(metadata);
    expect(() =>
      paginationMetadataV1({ ...result }),
    ).toThrow('expected a factory-issued result');
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(isPaginationMetadataV1(metadata)).toBe(true);
    expect(isPaginationMetadataV1({ ...metadata, totalPages: 4 })).toBe(false);
    expect(isPaginationMetadataV1({ ...metadata, hasNextPage: false })).toBe(false);
    expect(isPaginationMetadataV1({ ...metadata, page: 1.5 })).toBe(false);
  });

  it('creates the browser projection through the same coordinate authority', () => {
    const data = [{ id: 'tenant-1' }];
    const page = createPaginatedDataResultV1(data, 3, 1, 1);

    expect(page).toEqual({
      data,
      total: 3,
      page: 1,
      limit: 1,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: false,
    });
    expect(page.data).not.toBe(data);
    expect(Object.isFrozen(page.data)).toBe(true);
    data.push({ id: 'tenant-2' });
    expect(page.data).toEqual([{ id: 'tenant-1' }]);
  });

  it('keeps opaque cursor pagination distinct and fail-closed', () => {
    const result = createCursorPaginationResultV1(['entry-1'], 2, true, 'next-cursor');

    expect(result).toEqual({
      items: ['entry-1'],
      totalCount: 2,
      hasMore: true,
      cursor: 'next-cursor',
    });
    expect(isCursorPaginationResultV1(result)).toBe(true);
    expect(isCursorPaginationResultV1({ ...result })).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(() => createCursorPaginationResultV1([], 2, true, null)).toThrow(
      'must be present exactly when hasMore is true',
    );
    expect(() => createCursorPaginationResultV1([], 0, false, 'stale-cursor')).toThrow(
      'must be present exactly when hasMore is true',
    );
  });
});
