/**
 * GraphQL replay error — carries the server's `extensions.code` so the offline
 * queue can classify a failed replay by CONTRACT instead of by message text
 * (MOB-CRITICAL-018 class).
 *
 * WHY: the queue used to see only `Error(message)`. `isRetryableError` then
 * pattern-matched the text ('validation', 'bad request', …), and a variable
 * coercion failure — `Variable "$input" got invalid value …`, the exact error a
 * stale payload produces — matched none of them. The op burned all five retries
 * on a payload that could never succeed and then sat in the queue as "failed"
 * with no reason a user could act on. The code is the server's own verdict;
 * the message stays for display only.
 *
 * Shared by the foreground executor (useOfflineQueue) and the service-worker
 * executor (sw-replay) so both lanes record the same `lastErrorCode`.
 */

/**
 * Codes that mean "this payload will not succeed on retry": the request is
 * malformed or refused by policy, not by a transient fault. Apollo Server /
 * NestJS conventions. Anything else (INTERNAL_SERVER_ERROR, a custom code, or
 * no code at all) stays retryable.
 */
export const PERMANENT_GRAPHQL_ERROR_CODES = [
  'BAD_USER_INPUT',
  'GRAPHQL_VALIDATION_FAILED',
  'BAD_REQUEST',
  'FORBIDDEN',
  'UNAUTHENTICATED',
  'NOT_FOUND',
] as const;

export type PermanentGraphQLErrorCode = (typeof PERMANENT_GRAPHQL_ERROR_CODES)[number];

export function isPermanentGraphQLErrorCode(code: string): code is PermanentGraphQLErrorCode {
  return PERMANENT_GRAPHQL_ERROR_CODES.some((permanent) => permanent === code);
}

/** One element of a GraphQL response `errors` array, as the wire delivers it. */
export interface GraphQLEnvelopeError {
  readonly message?: string;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export class GraphQLReplayError extends Error {
  /** The server's `extensions.code`, when the first error carried one. */
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'GraphQLReplayError';
    this.code = code;
  }

  /** Build from a non-empty `errors` array; the first error is authoritative. */
  static fromEnvelope(errors: readonly GraphQLEnvelopeError[]): GraphQLReplayError {
    const first = errors[0];
    const code = first?.extensions?.code;
    return new GraphQLReplayError(
      first?.message || 'GraphQL error',
      typeof code === 'string' ? code : undefined,
    );
  }
}
