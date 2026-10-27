/**
 * How a replayed offline write's answer becomes its result or its rejection (PKG-42; ADR-051 C6;
 * MOB-MEDIUM-031).
 *
 * WHY: a write the server rejects with a code in PERMANENT_GRAPHQL_ERROR_CODES is listed on the
 * Sync Status page for re-entry (rejected-replays.ts), which needs the code on the queued
 * operation. Both replay lanes threw a code-less `HTTP error: <status>` on any non-2xx answer
 * before they read its body. The gateway (Apollo Server 5) answers a document that no longer
 * validates against the schema — the BREAKING-release case C6 exists for — with HTTP 400 and
 * GRAPHQL_VALIDATION_FAILED, and a variable it cannot coerce with HTTP 400 and BAD_USER_INPUT.
 * Those replays lost their code, were retried five times on a payload that can never succeed,
 * and ended as a bare "Permanently failed" row without the reason or the values entered.
 *
 * WHAT — the one reader, used by every replay lane (the foreground executor and its upload lane
 * through services/replay-request.ts, the closed-app lane in sw-replay.ts):
 *   - a GraphQL envelope with a non-empty errors array, whatever the HTTP status, throws
 *     GraphQLReplayError with the first error's code (graphql-replay-error.ts);
 *   - any other non-2xx answer (an edge's HTML 502, a proxy's 413) throws HttpStatusError:
 *     no code, so the queue retries it by its transport rule;
 *   - a 2xx answer returns its `data`.
 * Free of window and service-worker globals: both contexts import it.
 */
import { GraphQLReplayError } from './graphql-replay-error';

import { HttpStatusError } from '@/services/request-failure';
import { readGraphQLResponse, type GraphQLErrorPayload } from '@/utils/graphql-response';

/** The errors array of a non-2xx answer's body; empty when the body is not a GraphQL envelope. */
async function rejectionErrorsOf(response: Response): Promise<readonly GraphQLErrorPayload[]> {
  try {
    const { errors } = await readGraphQLResponse<unknown>(response);
    return errors ?? [];
  } catch {
    // Not JSON (an edge's HTML error page, an empty body): there is no envelope to read.
    return [];
  }
}

/** The replayed operation's `data`; throws its rejection, coded when the server coded it. */
export async function readReplayResponse<TData>(response: Response): Promise<TData | undefined> {
  if (!response.ok) {
    const errors = await rejectionErrorsOf(response);
    if (errors.length > 0) throw GraphQLReplayError.fromEnvelope(errors);
    throw new HttpStatusError(response.status);
  }
  const result = await readGraphQLResponse<TData>(response);
  if (result.errors !== undefined && result.errors.length > 0) {
    throw GraphQLReplayError.fromEnvelope(result.errors);
  }
  return result.data;
}
