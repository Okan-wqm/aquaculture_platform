/**
 * The one reader of a replayed write's answer (PKG-42; ADR-051 C6).
 *
 * The gateway (Apollo Server 5) answers a document that no longer validates against the schema
 * with HTTP 400 and GRAPHQL_VALIDATION_FAILED, and a variable it cannot coerce with HTTP 400 and
 * BAD_USER_INPUT. Both replay lanes threw a code-less `HTTP error: 400` before reading the body,
 * so such a replay was retried five times and never listed for re-entry. A rejection now keeps
 * the server's code whatever the HTTP status; only an answer that is no GraphQL envelope stays
 * a code-less transport error the queue retries.
 */
import { describe, expect, it } from 'vitest';

import { GraphQLReplayError } from '../graphql-replay-error';
import { readReplayResponse } from '../replay-response';

import { HttpStatusError } from '@/services/request-failure';

function envelope(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function rejectedWith(code: string, status: number): Response {
  return envelope(status, { errors: [{ message: `rejected: ${code}`, extensions: { code } }] });
}

describe('readReplayResponse', () => {
  it('returns the data of an accepted replay', async () => {
    await expect(
      readReplayResponse(envelope(200, { data: { recordMortality: { id: 'm-1' } } })),
    ).resolves.toEqual({ recordMortality: { id: 'm-1' } });
  });

  it.each(['GRAPHQL_VALIDATION_FAILED', 'BAD_USER_INPUT', 'BAD_REQUEST'])(
    'keeps the code of an HTTP 400 rejection coded %s',
    async (code) => {
      const rejection = readReplayResponse(rejectedWith(code, 400));
      await expect(rejection).rejects.toBeInstanceOf(GraphQLReplayError);
      await expect(rejection).rejects.toMatchObject({ code, message: `rejected: ${code}` });
    },
  );

  it('keeps the code of a rejection the server answers with HTTP 200 (FORBIDDEN)', async () => {
    await expect(readReplayResponse(rejectedWith('FORBIDDEN', 200))).rejects.toMatchObject({
      name: 'GraphQLReplayError',
      code: 'FORBIDDEN',
    });
  });

  it('keeps the code of a rejection the gateway answers with HTTP 401 (UNAUTHENTICATED)', async () => {
    await expect(readReplayResponse(rejectedWith('UNAUTHENTICATED', 401))).rejects.toMatchObject({
      name: 'GraphQLReplayError',
      code: 'UNAUTHENTICATED',
    });
  });

  it('reads an edge error page as a code-less transport error the queue retries', async () => {
    const rejection = readReplayResponse(
      new Response('<html><body>502 Bad Gateway</body></html>', { status: 502 }),
    );
    await expect(rejection).rejects.toBeInstanceOf(HttpStatusError);
    await expect(rejection).rejects.toMatchObject({ status: 502, message: 'HTTP error: 502' });
  });

  it('reads a non-2xx JSON body without errors as a code-less transport error', async () => {
    await expect(readReplayResponse(envelope(413, { message: 'too large' }))).rejects.toEqual(
      new HttpStatusError(413),
    );
  });
});
