/**
 * The in-memory half of MOB-MEDIUM-031 (PKG-42).
 *
 * React Query keeps a query's last good data when a refetch fails, so a screen the worker had
 * open — or reopens within the 24 h gcTime — kept showing tanks and readings after the server
 * started refusing the caller. The client's QueryCache drops a query's data the moment a fetch
 * is refused (FORBIDDEN, UNAUTHENTICATED, HTTP 401/403); an outage leaves it in place, which is
 * what the stale-while-offline screens rely on.
 */
import { QueryCache, QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { GraphQLError } from '../authenticated-fetch';
import { dropRefusedQueryData } from '../drop-refused-query-data';
import { HttpStatusError, NetworkUnreachableError } from '../request-failure';

const KEY = ['tenant', 'tenant-1', 'tanks'];

function client(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: dropRefusedQueryData }),
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
}

async function loadThenFail(failure: unknown): Promise<unknown> {
  const queryClient = client();
  await queryClient.fetchQuery({
    queryKey: KEY,
    queryFn: () => Promise.resolve([{ id: 'tank-1' }]),
  });
  await queryClient
    .fetchQuery({ queryKey: KEY, queryFn: () => Promise.reject(failure) })
    .catch(() => undefined);
  return queryClient.getQueryData(KEY);
}

describe('dropRefusedQueryData', () => {
  it.each([
    [
      'a GraphQL FORBIDDEN',
      new GraphQLError([{ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } }]),
    ],
    [
      'a GraphQL UNAUTHENTICATED',
      new GraphQLError([{ message: 'No', extensions: { code: 'UNAUTHENTICATED' } }]),
    ],
    ['an HTTP 401', new HttpStatusError(401)],
    ['an HTTP 403', new HttpStatusError(403)],
  ])('drops the data a query held when the server answers %s', async (_label, refusal) => {
    expect(await loadThenFail(refusal)).toBeUndefined();
  });

  it('keeps the data through an outage', async () => {
    expect(await loadThenFail(new NetworkUnreachableError('Failed to fetch'))).toEqual([
      { id: 'tank-1' },
    ]);
  });

  it('keeps the data through any other failure', async () => {
    const badInput = new GraphQLError([{ message: 'bad', extensions: { code: 'BAD_USER_INPUT' } }]);
    expect(await loadThenFail(badInput)).toEqual([{ id: 'tank-1' }]);
  });
});
