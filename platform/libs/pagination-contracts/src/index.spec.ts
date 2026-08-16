import {
  createStandardPaginatedResult,
  expectedTotalPages,
  PaginationContractError,
} from './index';

describe('pagination contract authority', () => {
  it('derives all redundant metadata in one place', () => {
    expect(createStandardPaginatedResult(['a', 'b'], 3, 1, 2)).toEqual({
      items: ['a', 'b'],
      total: 3,
      page: 1,
      limit: 2,
      totalPages: 2,
      hasNextPage: true,
      hasPreviousPage: false,
    });
    expect(expectedTotalPages(0, 20)).toBe(1);
  });

  it('accepts honest empty stale pages and rejects impossible non-empty pages', () => {
    expect(() => createStandardPaginatedResult(['a', 'b'], 1, 1, 2)).toThrow(
      PaginationContractError,
    );
    expect(() => createStandardPaginatedResult([], 5, 3, 2)).not.toThrow();
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
});
