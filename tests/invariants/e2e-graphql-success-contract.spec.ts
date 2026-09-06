import { GraphQLTestClient, GraphQLTestError } from '../../e2e/helpers/graphql-client';

function playwrightTransport(body: unknown): { post: jest.Mock } {
  return {
    post: jest.fn().mockResolvedValue({
      json: async (): Promise<unknown> => body,
      status: (): number => 200,
      headers: (): Record<string, string> => ({}),
    }),
  };
}

describe('E2E successful GraphQL operations have one data contract', () => {
  it('returns actual data through the Playwright transport', async () => {
    const transport = playwrightTransport({ data: { createSite: { id: 'site-id' } } });
    const client = new GraphQLTestClient(transport);
    await expect(
      client.executeSuccess({ query: 'mutation { createSite { id } }', token: 'fixture-token' }),
    ).resolves.toEqual({ createSite: { id: 'site-id' } });
    expect(transport.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer fixture-token' }),
      }),
    );
  });

  it('rejects GraphQL errors even with partial data and HTTP 200', async () => {
    const client = new GraphQLTestClient(
      playwrightTransport({
        data: { createSite: null },
        errors: [{ message: 'Not authorized' }],
      }),
    );
    await expect(
      client.executeSuccess({ query: 'mutation { createSite { id } }' }),
    ).rejects.toBeInstanceOf(GraphQLTestError);
  });

  it.each([{}, { data: null }])('rejects an empty successful envelope', async (body) => {
    const client = new GraphQLTestClient(playwrightTransport(body));
    await expect(client.executeSuccess({ query: '{ currentUser { id } }' })).rejects.toThrow(
      'GraphQL response missing data field',
    );
  });
});
