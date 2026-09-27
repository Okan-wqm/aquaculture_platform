/**
 * GraphQL error-code contract — types + readers for the messaging panel.
 *
 * The gateway (Apollo Federation) maps every service error to a contractual
 * code in `errors[0].extensions.code` (SSoT: gateway-api
 * global-exception.filter + backend-common MutationRateLimitGuard). FAZ 1.1
 * will drive the ChatRoom error banner from THESE predicates — never from
 * message-string sniffing, which is locale- and phrasing-fragile.
 *
 * Readers accept `unknown` because real failures arrive wrapped (graphql-request
 * `ClientError` with `response.errors`, Apollo `GraphQLError` with direct
 * `extensions`, react-query `Error` re-wraps…) — the extraction walks each
 * known shape and stays total: anything unrecognized yields `undefined`, not
 * a throw.
 */

/**
 * Error codes the gateway contractually emits. Mirror of the backend SSoT —
 * extend ONLY together with the gateway filter (see module e2e contract in
 * /e2e/messaging/measurements.ts GRAPHQL_ERROR_CODES).
 */
export const GRAPHQL_ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'UNPROCESSABLE_ENTITY',
  'TOO_MANY_REQUESTS',
  'INTERNAL_SERVER_ERROR',
] as const;

export type GraphQLErrorCode = (typeof GRAPHQL_ERROR_CODES)[number];

/** Minimal GraphQL error entry shape the panel needs (message + extensions). */
export interface GraphQLErrorLike {
  message?: string;
  extensions?: Record<string, unknown> | null;
}

/** A GraphQL response envelope carrying optional errors. */
export interface GraphQLErrorEnvelope {
  errors?: GraphQLErrorLike[] | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isGraphQLErrorCode(value: unknown): value is GraphQLErrorCode {
  return typeof value === 'string' && (GRAPHQL_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * The first GraphQL error entry carried by `error`, whatever wrapper it
 * hides in (envelope, graphql-request ClientError, bare Apollo error).
 * Returns undefined when the value carries no GraphQL error at all (e.g. a
 * network TypeError) — that case is a transport failure, not a contract code.
 */
export function getFirstGraphQLError(error: unknown): GraphQLErrorLike | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  // 1. GraphQL response envelope: { errors: [...] }
  const envelopeErrors = error['errors'];
  if (Array.isArray(envelopeErrors) && envelopeErrors.length > 0) {
    return envelopeErrors[0] as GraphQLErrorLike;
  }

  // 2. graphql-request ClientError: { response: { errors: [...] } }
  const response = error['response'];
  if (isRecord(response)) {
    const responseErrors = response['errors'];
    if (Array.isArray(responseErrors) && responseErrors.length > 0) {
      return responseErrors[0] as GraphQLErrorLike;
    }
  }

  // 3. Bare Apollo-style GraphQLError: { extensions: { code } }
  if (isRecord(error['extensions'])) {
    return error;
  }

  return undefined;
}

/**
 * Reads the contractual `extensions.code` of the first GraphQL error on
 * `error`. Returns undefined when there is no GraphQL error or the code is
 * not part of the contract (unknown codes are a finding — FAZ 1.1 surfaces
 * them as the generic banner, and the e2e lane fails loudly on them).
 */
export function readGraphQLErrorCode(error: unknown): GraphQLErrorCode | undefined {
  const code = getFirstGraphQLError(error)?.extensions?.['code'];
  return isGraphQLErrorCode(code) ? code : undefined;
}

/** The operation was refused because the session/token is missing or expired. */
export function isUnauthenticated(error: unknown): boolean {
  return readGraphQLErrorCode(error) === 'UNAUTHENTICATED';
}

/** The session is valid but the caller may not touch this channel/tenant. */
export function isForbidden(error: unknown): boolean {
  return readGraphQLErrorCode(error) === 'FORBIDDEN';
}

/** The addressed entity (channel/message) does not exist for this caller. */
export function isNotFound(error: unknown): boolean {
  return readGraphQLErrorCode(error) === 'NOT_FOUND';
}

/**
 * A rate limit fired (MutationRateLimitGuard). The platform SSoT code is
 * TOO_MANY_REQUESTS; RATE_LIMITED is accepted as a forward-compatible alias
 * so a backend rename cannot silently un-limit the UX.
 */
export function isRateLimited(error: unknown): boolean {
  const rawCode = getFirstGraphQLError(error)?.extensions?.['code'];
  return rawCode === 'TOO_MANY_REQUESTS' || rawCode === 'RATE_LIMITED';
}
