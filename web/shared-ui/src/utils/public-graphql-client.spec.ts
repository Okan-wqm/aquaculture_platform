import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { publicGraphqlClient, GraphQLClientError } from './api-client';

describe('publicGraphqlClient (pre-auth, barrier-skipping)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to /graphql with NO Authorization or X-Tenant-Id header', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      json: async () => ({ data: { forgotPassword: true } }),
    });

    const data = await publicGraphqlClient.request<{ forgotPassword: boolean }>(
      'mutation { forgotPassword }',
      {},
    );

    expect(data).toEqual({ forgotPassword: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/graphql');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-Tenant-Id']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('throws a GraphQLClientError carrying the GraphQL error message', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      json: async () => ({ errors: [{ message: 'invalid or expired token' }] }),
    });

    await expect(publicGraphqlClient.request('query { x }')).rejects.toBeInstanceOf(
      GraphQLClientError,
    );
    await expect(publicGraphqlClient.request('query { x }')).rejects.toThrow(
      'invalid or expired token',
    );
  });

  it('surfaces a TYPED BACKEND_UNAVAILABLE error on a 502 (not a JSON-parse crash)', async () => {
    fetchMock.mockResolvedValue({
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });

    await expect(publicGraphqlClient.request('query { x }')).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
    });
  });
});
