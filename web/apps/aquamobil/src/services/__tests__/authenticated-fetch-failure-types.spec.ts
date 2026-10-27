// MOB-MEDIUM-031 (PKG-42): the transport says HOW a request failed, as a type, so the offline
// cache can tell an outage from the server's refusal without reading message text. A request
// that never got an answer throws NetworkUnreachableError; an answer that is not 2xx throws
// HttpStatusError carrying its status; a GraphQL error keeps throwing GraphQLError with the
// server's codes. Messages stay what they were, for display and for the queue's legacy
// message heuristics.

import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { print, parse } from 'graphql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authenticatedFetch,
  graphqlRequest,
  markAuthReady,
  resetAuthReady,
} from '../authenticated-fetch';
import { GraphQLError, HttpStatusError, NetworkUnreachableError } from '../request-failure';

const PING: TypedDocumentNode<{ ping: boolean }, Record<string, never>> = parse(
  'query Ping { ping }',
);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('authenticated transport failure types', () => {
  beforeEach(() => {
    resetAuthReady();
    markAuthReady();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws NetworkUnreachableError, with the browser message, when fetch itself rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const failure = authenticatedFetch('/graphql', { method: 'POST', body: print(PING) });

    await expect(failure).rejects.toBeInstanceOf(NetworkUnreachableError);
    await expect(failure).rejects.toThrow('Failed to fetch');
  });

  it('graphqlRequest throws HttpStatusError carrying the status of a non-2xx answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(503, {})));

    const failure = graphqlRequest(PING);

    await expect(failure).rejects.toBeInstanceOf(HttpStatusError);
    await expect(failure).rejects.toMatchObject({ status: 503, message: 'HTTP error: 503' });
  });

  it('graphqlRequest keeps throwing GraphQLError with the server codes for GraphQL errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, { errors: [{ message: 'denied', extensions: { code: 'FORBIDDEN' } }] }),
        ),
    );

    const failure = graphqlRequest(PING);

    await expect(failure).rejects.toBeInstanceOf(GraphQLError);
    await expect(failure).rejects.toMatchObject({
      graphqlErrors: [{ message: 'denied', extensions: { code: 'FORBIDDEN' } }],
    });
  });
});
