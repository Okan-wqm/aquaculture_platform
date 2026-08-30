import * as pagination from '../index';

describe('backend pagination projection', () => {
  it('re-derives redundant CQRS metadata through the platform authority', () => {
    const result = pagination.fromCqrsPaginated({
      data: ['a', 'b'],
      pagination: {
        page: 2,
        limit: 2,
        total: 5,
        totalPages: 999,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });

    expect(result).toEqual({
      items: ['a', 'b'],
      total: 5,
      page: 2,
      limit: 2,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: true,
    });
    expect(pagination.isStandardPaginatedResult(result)).toBe(true);
  });

  it('does not re-export the retired offset/hasMore authority', () => {
    expect(pagination).not.toHaveProperty('calculateHasMore');
    expect(pagination).not.toHaveProperty('createPaginatedResult');
    expect(pagination).not.toHaveProperty('PaginatedResponse');
  });

  it('keeps the GraphQL bridge assignable from immutable authority output', () => {
    const GraphqlPage = pagination.StandardPaginatedResponse(String);
    const authorityPage = pagination.createStandardPaginatedResult(['a'], 1, 1, 20);

    const graphQlCompatiblePage: InstanceType<typeof GraphqlPage> = authorityPage;
    expect(graphQlCompatiblePage.items).toEqual(['a']);
  });
});
