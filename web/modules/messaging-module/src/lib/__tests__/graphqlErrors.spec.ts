import { describe, it, expect } from 'vitest';

import {
  GRAPHQL_ERROR_CODES,
  getFirstGraphQLError,
  isForbidden,
  isNotFound,
  isRateLimited,
  isUnauthenticated,
  readGraphQLErrorCode,
  type GraphQLErrorEnvelope,
} from '../graphqlErrors';

/** GraphQL response envelope ({ errors }) — the shape graphql-request sees. */
function envelope(code: string, message = 'boom'): GraphQLErrorEnvelope {
  return { errors: [{ message, extensions: { code } }] };
}

/** graphql-request ClientError shape ({ response: { errors } }). */
function clientError(code: string): unknown {
  return {
    name: 'ClientError',
    message: 'GraphQL Error (Code: 404)',
    response: { errors: [{ message: 'not there', extensions: { code } }] },
  };
}

/** Bare Apollo-style GraphQLError (extensions directly on the error). */
function apolloError(code: string): unknown {
  return { message: 'direct', extensions: { code } };
}

describe('readGraphQLErrorCode', () => {
  it('reads the code from a response envelope', () => {
    expect(readGraphQLErrorCode(envelope('NOT_FOUND'))).toBe('NOT_FOUND');
  });

  it('reads the code from a graphql-request ClientError wrapper', () => {
    expect(readGraphQLErrorCode(clientError('FORBIDDEN'))).toBe('FORBIDDEN');
  });

  it('reads the code from a bare Apollo-style error', () => {
    expect(readGraphQLErrorCode(apolloError('UNAUTHENTICATED'))).toBe('UNAUTHENTICATED');
  });

  it('uses only the FIRST error when several are present', () => {
    const result: GraphQLErrorEnvelope = {
      errors: [
        { message: 'primary', extensions: { code: 'CONFLICT' } },
        { message: 'secondary', extensions: { code: 'NOT_FOUND' } },
      ],
    };
    expect(readGraphQLErrorCode(result)).toBe('CONFLICT');
  });

  it('returns undefined for non-contractual codes', () => {
    expect(readGraphQLErrorCode(envelope('SOMETHING_ELSE'))).toBeUndefined();
  });

  it('returns undefined when extensions is missing or code is not a string', () => {
    expect(readGraphQLErrorCode({ errors: [{ message: 'bare' }] })).toBeUndefined();
    expect(readGraphQLErrorCode({ errors: [{ extensions: { code: 42 } }] })).toBeUndefined();
  });

  it('returns undefined for non-GraphQL values (network failures, null, strings)', () => {
    expect(readGraphQLErrorCode(new TypeError('fetch failed'))).toBeUndefined();
    expect(readGraphQLErrorCode(null)).toBeUndefined();
    expect(readGraphQLErrorCode('UNAUTHENTICATED')).toBeUndefined();
    expect(readGraphQLErrorCode({ errors: [] })).toBeUndefined();
    expect(readGraphQLErrorCode({})).toBeUndefined();
  });
});

describe('code predicates', () => {
  it('isUnauthenticated matches only UNAUTHENTICATED across wrapper shapes', () => {
    expect(isUnauthenticated(envelope('UNAUTHENTICATED'))).toBe(true);
    expect(isUnauthenticated(clientError('UNAUTHENTICATED'))).toBe(true);
    expect(isUnauthenticated(apolloError('UNAUTHENTICATED'))).toBe(true);
    expect(isUnauthenticated(envelope('FORBIDDEN'))).toBe(false);
    expect(isUnauthenticated(new Error('x'))).toBe(false);
  });

  it('isForbidden matches only FORBIDDEN', () => {
    expect(isForbidden(envelope('FORBIDDEN'))).toBe(true);
    expect(isForbidden(envelope('UNAUTHENTICATED'))).toBe(false);
    expect(isForbidden(envelope('NOT_FOUND'))).toBe(false);
  });

  it('isNotFound matches only NOT_FOUND', () => {
    expect(isNotFound(clientError('NOT_FOUND'))).toBe(true);
    expect(isNotFound(envelope('CONFLICT'))).toBe(false);
  });

  it('isRateLimited matches TOO_MANY_REQUESTS (platform SSoT) and the RATE_LIMITED alias', () => {
    expect(isRateLimited(envelope('TOO_MANY_REQUESTS'))).toBe(true);
    expect(isRateLimited(envelope('RATE_LIMITED'))).toBe(true);
    expect(isRateLimited(envelope('NOT_FOUND'))).toBe(false);
    expect(isRateLimited(new TypeError('network'))).toBe(false);
  });
});

describe('getFirstGraphQLError', () => {
  it('returns the first error entry with its message', () => {
    const first = getFirstGraphQLError(envelope('NOT_FOUND', 'channel gone'));
    expect(first?.message).toBe('channel gone');
  });

  it('returns undefined for error-free payloads', () => {
    expect(getFirstGraphQLError({ data: { ok: true } })).toBeUndefined();
    expect(getFirstGraphQLError(undefined)).toBeUndefined();
  });
});

describe('GRAPHQL_ERROR_CODES contract set', () => {
  it('contains the gateway SSoT codes', () => {
    expect(GRAPHQL_ERROR_CODES).toContain('UNAUTHENTICATED');
    expect(GRAPHQL_ERROR_CODES).toContain('FORBIDDEN');
    expect(GRAPHQL_ERROR_CODES).toContain('NOT_FOUND');
    expect(GRAPHQL_ERROR_CODES).toContain('TOO_MANY_REQUESTS');
    expect(GRAPHQL_ERROR_CODES).toContain('INTERNAL_SERVER_ERROR');
  });
});
