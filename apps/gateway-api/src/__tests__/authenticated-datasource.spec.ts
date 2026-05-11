import { createHash } from 'crypto';

import { AuthenticatedDataSource } from '../app.module';

/**
 * ORPHAN-CRITICAL-075 regression spec.
 *
 * Pins the exact contract between gateway-api's HMAC signer (in
 * `AuthenticatedDataSource.willSendRequest`) and Apollo Gateway's
 * `RemoteGraphQLDataSource.sendRequest` wire-body serialization.
 *
 * The CRITICAL bug it guards against:
 *
 *   Apollo Gateway constructs `request.http = { method, url, headers }`
 *   BEFORE invoking willSendRequest. `request.http.body` is NEVER set
 *   at the hook callsite. The actual wire body is computed inside
 *   `sendRequest()` as `JSON.stringify({...request, http: undefined})`.
 *
 *   The pre-fix signer (`apps/gateway-api/src/app.module.ts` at HEAD
 *   86b67ae8) signed `JSON.stringify(outgoingRequest.body ?? '')` which
 *   collapsed to `JSON.stringify('')` = `'""'`. The subgraph re-computed
 *   `sha256(observedBody)` from the real wire bytes, the digests never
 *   matched, every authenticated mutation was rejected with
 *   `outcome.reason = 'invalid-hmac'` and operators saw
 *   "Invalid service identity signature" on every login.
 *
 * The post-fix signer extracts `{ http, ...requestWithoutHttp }` from the
 * SAME `request` object Apollo will later strip in `sendRequest`, then
 * JSON.stringify's `requestWithoutHttp` to get the EXACT bytes Apollo will
 * send. V8 JSON.stringify is deterministic on insertion order, so the
 * subgraph's `JSON.stringify(req.body)` (after body-parser round-trips
 * the wire bytes through `JSON.parse`) yields the same canonical string.
 *
 * Concrete invariants this spec pins:
 *
 *   1. The signer sets `X-Service-Body-Hash` to
 *      `sha256(JSON.stringify({query, variables, operationName?, extensions?}))`.
 *      This is the hash Apollo's wire body will carry, NOT
 *      `sha256(JSON.stringify(''))`.
 *
 *   2. The signed-body digest is byte-stable across any object built from
 *      the same {query, variables, ...} fields — JSON.parse/stringify
 *      round-trip preserves the canonical form.
 *
 *   3. The seven v2 service-identity headers are present and the digest
 *      header matches the sha256 of the canonical wire body.
 *
 * If any of these break, the production HMAC signer ↔ subgraph guard
 * contract is silently broken again. Restoration cost ~17h of operator
 * triage last time.
 */
describe('AuthenticatedDataSource — HMAC signer wire-body contract (ORPHAN-CRITICAL-075)', () => {
  // Helper: invoke willSendRequest with a stub Apollo request envelope and
  // a recording header collector, returning the header dict that the signer
  // would have set on the outbound Apollo subgraph fetch.
  function exerciseSigner(request: Record<string, unknown>): Record<string, string> {
    const recorded: Record<string, string> = {};
    const headers = {
      set: (key: string, value: string): void => {
        recorded[key] = value;
      },
    };

    // Apollo Gateway shape: request.http carries only { method, url, headers }
    // BEFORE willSendRequest is invoked. body is intentionally absent.
    const apolloRequest = {
      ...request,
      http: {
        method: 'POST',
        url: 'http://auth-service:3000/graphql',
        headers,
      },
    };

    const params = {
      request: apolloRequest as Parameters<AuthenticatedDataSource['willSendRequest']>[0]['request'],
      context: {
        req: {
          headers: {},
          user: undefined,
        },
        // res is unused by the signer path
        res: { append: (): void => undefined },
      } as Parameters<AuthenticatedDataSource['willSendRequest']>[0]['context'],
    };

    const ds = new AuthenticatedDataSource({
      url: 'http://auth-service:3000/graphql',
      secret: 'test-shared-secret-32-bytes-min!!!',
    });
    ds.willSendRequest(params);
    return recorded;
  }

  it('signs the body Apollo will actually send (JSON.stringify(request minus http)) — not request.http.body', () => {
    const query = 'mutation Login($input: LoginInput!) { login(input: $input) { accessToken } }';
    const variables = { input: { email: 'by-okan@live.com', password: 'redacted' } };
    const operationName = 'Login';

    const headers = exerciseSigner({ query, variables, operationName });

    expect(headers['X-Service-Sig-Version']).toBe('v2');
    expect(headers['X-Service-Identity']).toBe('gateway-api');
    expect(headers['X-Service-Method']).toBe('POST');
    expect(headers['X-Service-Path']).toBe('/graphql');

    // The CRITICAL invariant: body-hash digests the bytes Apollo SENDS,
    // not the bytes request.http.body would have held (= absent).
    const expectedWireBody = JSON.stringify({ query, variables, operationName });
    const expectedDigest = createHash('sha256').update(expectedWireBody).digest('hex');
    expect(headers['X-Service-Body-Hash']).toBe(expectedDigest);

    // Negative assertion: the pre-fix bug signed sha256('""') because the
    // signer reached for request.http.body which was undefined. Pin that
    // the post-fix digest is NEVER that value.
    const buggyDigest = createHash('sha256').update('""').digest('hex');
    expect(headers['X-Service-Body-Hash']).not.toBe(buggyDigest);
  });

  it('matches the digest a subgraph would compute by re-stringifying its parsed body', () => {
    const query = '{ ping }';
    const variables = { x: 1 };
    const extensions = { traceparent: '00-0000000000000000-0000000000000000-00' };

    const headers = exerciseSigner({ query, variables, extensions });

    // Simulate the wire round-trip: signer → bytes Apollo will send →
    // body-parser parses them → guard re-serializes for hashing.
    const wireBytes = JSON.stringify({ query, variables, extensions });
    const subgraphParsedBody = JSON.parse(wireBytes) as Record<string, unknown>;
    const subgraphReSerialized = JSON.stringify(subgraphParsedBody);
    const subgraphObservedDigest = createHash('sha256')
      .update(subgraphReSerialized)
      .digest('hex');

    // The signed digest equals what the subgraph guard will observe. This
    // is the property that closes the HMAC mismatch class.
    expect(headers['X-Service-Body-Hash']).toBe(subgraphObservedDigest);
  });

  it('emits the seven v2 service-identity headers exactly (no v1 leakage)', () => {
    const headers = exerciseSigner({ query: '{__typename}' });

    expect(Object.keys(headers).sort()).toEqual(
      [
        'X-Service-Body-Hash',
        'X-Service-Identity',
        'X-Service-Method',
        'X-Service-Path',
        'X-Service-Sig-Version',
        'X-Service-Signature',
        'X-Service-Timestamp',
      ].sort(),
    );
  });
});
