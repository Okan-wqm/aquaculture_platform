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
 *       unreachable — the network, or a 5xx from the edge (the gateway down or failing before
 *                     it judged the caller): the cached copy may stand in;
 *       refused     — HTTP 401/403, or a GraphQL FORBIDDEN / UNAUTHENTICATED anywhere in the
 *                     errors array: the server judged the caller, the cache must go;
 *       failed      — everything else (bad input, another 4xx, a programming error): surfaces
 *                     as an error; the cache neither stands in nor goes.
 */
import type { GraphQLErrorPayload } from '@/utils/graphql-response';

export type RequestFailure = 'unreachable' | 'refused' | 'failed';

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

/** The GraphQL codes with which the server refuses the caller rather than the request. */
const REFUSAL_CODES: readonly string[] = ['FORBIDDEN', 'UNAUTHENTICATED'];

export function classifyRequestFailure(error: unknown): RequestFailure {
  if (error instanceof NetworkUnreachableError) return 'unreachable';
  if (error instanceof HttpStatusError) {
    if (error.status === 401 || error.status === 403) return 'refused';
    return error.status >= 500 ? 'unreachable' : 'failed';
  }
  if (error instanceof GraphQLError) {
    const refused = error.graphqlErrors.some((graphqlError) => {
      const code = graphqlError.extensions?.code;
      return typeof code === 'string' && REFUSAL_CODES.includes(code);
    });
    return refused ? 'refused' : 'failed';
  }
  return 'failed';
}
