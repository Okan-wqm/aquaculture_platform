/**
 * How an authenticated request failed, by type (MOB-MEDIUM-031, PKG-42).
 *
 * WHY: every offline-cached read wrapped the network call in one catch-all and served the
 * encrypted cache for whatever was thrown, so the server's own refusal — FORBIDDEN,
 * UNAUTHENTICATED — put cached alarms, tanks and readings on screen exactly as an outage did.
 * Telling the two apart by message text is the MOB-CRITICAL-021 class; the transport
 * (authenticated-fetch.ts) throws one of the types below, and one classifier reads them.
 *
 * WHAT — the one owner of the transport's failure types:
 *   - NetworkUnreachableError: `fetch` itself rejected — no answer reached the device. The
 *     browser's message is kept for display.
 *   - HttpStatusError: an answer outside 2xx, with its `status` (main.tsx's retry policy reads
 *     it); the message stays `HTTP error: <status>`.
 *   - GraphQLError: a GraphQL `errors` array, with the server's codes.
 *   - classifyRequestFailure:
 *       unreachable     — the network, or a 5xx from the edge (the gateway down or failing
 *                         before it judged the caller): the cached copy may stand in;
 *       session-refused — HTTP 401, or a GraphQL UNAUTHENTICATED anywhere in the errors array:
 *                         the server refused the session itself, so nothing cached for the
 *                         caller may stay;
 *       read-refused    — HTTP 403, or a GraphQL FORBIDDEN anywhere in the errors array: the
 *                         server refused this read to a live session. Only what the read itself
 *                         cached must go — a FORBIDDEN is answered per resolver (ADR-051 §4: a
 *                         farm-only worker is refused every sensor read), so it says nothing
 *                         about the caller's other reads; a grant change mints a token in
 *                         another cache scope (offline-cache-scope.ts) and a dead session is
 *                         refused as a session;
 *       failed          — everything else (bad input, another 4xx, a programming error):
 *                         surfaces as an error; the cache neither stands in nor goes.
 *   - isRefusal: either refusal — the server judged the caller and the screen must not keep
 *     what it refused.
 */
import type { GraphQLErrorPayload } from '@/utils/graphql-response';

export type RequestFailure = 'unreachable' | 'session-refused' | 'read-refused' | 'failed';

/** `fetch` rejected: offline, DNS, a dropped connection. */
export class NetworkUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkUnreachableError';
  }
}

/** The server answered with a status outside 2xx. */
export class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP error: ${status}`);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

/** The server answered with a GraphQL `errors` array. */
export class GraphQLError extends Error {
  // SSoT: the error element shape is the canonical GraphQLErrorPayload from
  // @/utils/graphql-response, so the parser and this class share ONE error type
  // instead of two near-duplicate inline shapes that could drift apart.
  public readonly graphqlErrors: readonly GraphQLErrorPayload[];

  constructor(errors: readonly GraphQLErrorPayload[]) {
    super(errors[0]?.message ?? 'GraphQL error');
    this.name = 'GraphQLError';
    this.graphqlErrors = errors;
  }
}

/** The codes of every error in a GraphQL errors array. */
function codesOf(error: GraphQLError): readonly unknown[] {
  return error.graphqlErrors.map((graphqlError) => graphqlError.extensions?.code);
}

export function classifyRequestFailure(error: unknown): RequestFailure {
  if (error instanceof NetworkUnreachableError) return 'unreachable';
  if (error instanceof HttpStatusError) {
    if (error.status === 401) return 'session-refused';
    if (error.status === 403) return 'read-refused';
    return error.status >= 500 ? 'unreachable' : 'failed';
  }
  if (error instanceof GraphQLError) {
    const codes = codesOf(error);
    if (codes.includes('UNAUTHENTICATED')) return 'session-refused';
    return codes.includes('FORBIDDEN') ? 'read-refused' : 'failed';
  }
  return 'failed';
}

/** Whether the server refused the caller — its session or this read. */
export function isRefusal(failure: RequestFailure): boolean {
  return failure === 'session-refused' || failure === 'read-refused';
}
