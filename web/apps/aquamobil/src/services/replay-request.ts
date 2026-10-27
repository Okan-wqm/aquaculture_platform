/**
 * The foreground replay transport (PKG-42; ADR-051 C6).
 *
 * WHY: the open app replays queued writes through two paths — one mutation per operation (with
 * the leave-request follow-up), and the media lane's presign and send. Each read the answer its
 * own way, and none kept the server's code on a non-2xx answer or, for the media lane, at all
 * (graphqlRequest throws the read path's GraphQLError, which the queue does not read). A
 * rejected replay then never reached the Sync Status page's re-entry list.
 *
 * WHAT: both paths send through authenticatedFetch — the one auth lane (auth-ready barrier,
 * single-flight 401 refresh, the live token; MSG-CRITICAL-057) — and read the answer through
 * pwa/replay-response.ts, so every rejection carries the server's code.
 *   - replayOperation(query, variables): the operation's `data`, whatever its shape;
 *   - replayDocument(document, variables): a typed document's `data`, which must be present.
 */
import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { print } from 'graphql';

import { authenticatedFetch } from './authenticated-fetch';

import { readReplayResponse } from '@/pwa/replay-response';

async function replay<TData>(query: string, variables: unknown): Promise<TData | undefined> {
  const response = await authenticatedFetch('/graphql', {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  });
  return readReplayResponse<TData>(response);
}

/** Replays one GraphQL operation; resolves to its `data`. */
export async function replayOperation(query: string, variables: unknown): Promise<unknown> {
  return replay<unknown>(query, variables);
}

/** Replays a typed document; resolves to its `data`, and fails when the answer carries none. */
export async function replayDocument<TResult, TVars>(
  document: TypedDocumentNode<TResult, TVars>,
  variables: TVars,
): Promise<TResult> {
  const data = await replay<TResult>(print(document), variables);
  if (data === undefined || data === null) throw new Error('No data returned');
  return data;
}
