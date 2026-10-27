/**
 * Why a read failed decides what the offline cache may do (MOB-MEDIUM-031, PKG-42).
 *
 * The cache was a fallback for outages, but every hook served it from one catch-all, so the
 * server's own refusal — FORBIDDEN, UNAUTHENTICATED — put the cached copy on screen exactly as
 * an outage did. The classifier separates three verdicts:
 *   - unreachable: no answer reached the device (the network, or an edge reporting the gateway
 *     down with a 5xx): the cached copy may stand in;
 *   - refused: the server answered and refused the caller: the cache must go;
 *   - failed: anything else (bad input, a bug, a 4xx): the error surfaces, the cache stays put.
 */
import { describe, expect, it } from 'vitest';

import {
  GraphQLError,
  HttpStatusError,
  NetworkUnreachableError,
  classifyRequestFailure,
} from '../request-failure';

function graphqlError(...codes: (string | undefined)[]): GraphQLError {
  return new GraphQLError(
    codes.map((code) => ({
      message: `error ${code ?? 'without a code'}`,
      extensions: code === undefined ? undefined : { code },
    })),
  );
}

describe('classifyRequestFailure', () => {
  it('reads a request that never reached the server as unreachable', () => {
    expect(classifyRequestFailure(new NetworkUnreachableError('Failed to fetch'))).toBe(
      'unreachable',
    );
  });

  it.each([500, 502, 503, 504])('reads an HTTP %i from the edge as unreachable', (status) => {
    expect(classifyRequestFailure(new HttpStatusError(status))).toBe('unreachable');
  });

  it.each([401, 403])('reads an HTTP %i as the server refusing the caller', (status) => {
    expect(classifyRequestFailure(new HttpStatusError(status))).toBe('refused');
  });

  it.each([400, 404, 409, 429])(
    'reads an HTTP %i as a failure the cache must not cover',
    (status) => {
      expect(classifyRequestFailure(new HttpStatusError(status))).toBe('failed');
    },
  );

  it.each(['FORBIDDEN', 'UNAUTHENTICATED'])('reads a GraphQL %s as a refusal', (code) => {
    expect(classifyRequestFailure(graphqlError(code))).toBe('refused');
  });

  it('reads a refusal anywhere in the errors array as a refusal', () => {
    expect(classifyRequestFailure(graphqlError('BAD_USER_INPUT', 'FORBIDDEN'))).toBe('refused');
  });

  it.each([
    ['BAD_USER_INPUT'],
    ['GRAPHQL_VALIDATION_FAILED'],
    ['INTERNAL_SERVER_ERROR'],
    [undefined],
  ])('reads a GraphQL error coded %s as a failure, not an outage', (code) => {
    expect(classifyRequestFailure(graphqlError(code))).toBe('failed');
  });

  it('reads a programming error (a TypeError thrown by a mapper) as a failure, not an outage', () => {
    expect(
      classifyRequestFailure(
        new TypeError("Cannot read properties of undefined (reading 'items')"),
      ),
    ).toBe('failed');
  });

  it('reads an unknown throw as a failure', () => {
    expect(classifyRequestFailure('boom')).toBe('failed');
    expect(classifyRequestFailure(new Error('Failed to fetch'))).toBe('failed');
  });

  it('keeps the status on the HTTP error for the retry policy and the message for display', () => {
    const error = new HttpStatusError(503);
    expect(error.status).toBe(503);
    expect(error.message).toBe('HTTP error: 503');
  });
});
