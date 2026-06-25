/**
 * Unit tests for service-identity.util — v1 (deprecated) + v2 (current).
 *
 * Closes: docs/reviews/auth-security-expert/2026-04-28-core-platform-review.md#SEC-CRITICAL-001
 * Closes: docs/reviews/security-reviewer/2026-04-28-core-platform-review.md#SECREV-CRITICAL-001
 */

import { createHash, createHmac } from 'crypto';

import {
  SERVICE_IDENTITY_MAX_AGE_MS,
  generateServiceIdentityHeaders,
  generateServiceIdentityHeadersV2,
  serializeServiceIdentityBodyForHash,
  verifyServiceIdentity,
  verifyServiceIdentityRequest,
  verifyServiceIdentityV2,
} from '../service-identity.util';

const SECRET = 'test-internal-secret-do-not-use-in-prod-this-is-only-a-fixture';
const SERVICE = 'gateway-api';
const TENANT = '11111111-1111-4111-8111-111111111111';
const PATH = '/graphql';
const METHOD = 'POST';
const BODY = '{"query":"{ farms { id } }"}';
const BODY_HASH = createHash('sha256').update(BODY).digest('hex');
const KEY_ID = 'kid-1';
const AUDIENCE = 'farm';
const CONTENT_TYPE = 'application/json';
const NONCE = 'nonce-1';
const EMPTY_QUERY_HASH = createHash('sha256').update('').digest('hex');
const KEYRING = [
  {
    kid: KEY_ID,
    secret: SECRET,
    status: 'active' as const,
    callers: [SERVICE],
    audiences: [AUDIENCE],
  },
];

function fullHeaders(): ReturnType<typeof generateServiceIdentityHeadersV2> {
  return generateServiceIdentityHeadersV2({
    serviceName: SERVICE,
    secret: SECRET,
    tenantId: TENANT,
    method: METHOD,
    path: PATH,
    body: BODY,
    keyId: KEY_ID,
    audience: AUDIENCE,
    contentType: CONTENT_TYPE,
    nonce: NONCE,
  });
}

function verifyArgs(
  h: ReturnType<typeof generateServiceIdentityHeadersV2>,
  overrides: Partial<Parameters<typeof verifyServiceIdentityV2>[0]> = {},
): Parameters<typeof verifyServiceIdentityV2>[0] {
  return {
    serviceName: h['X-Service-Identity'],
    timestamp: h['X-Service-Timestamp'],
    signature: h['X-Service-Signature'],
    method: h['X-Service-Method'],
    path: h['X-Service-Path'],
    bodyHash: h['X-Service-Body-Hash'],
    keyId: h['X-Service-Key-Id'],
    audience: h['X-Service-Audience'],
    queryHash: h['X-Service-Query-Hash'],
    contentType: h['X-Service-Content-Type'],
    assertionHash: h['X-Service-Assertion-Hash'],
    nonce: h['X-Service-Nonce'],
    effectiveTenantId: h['X-Service-Effective-Tenant-ID'],
    observedMethod: METHOD,
    observedPath: PATH,
    observedBody: BODY,
    observedQuery: '',
    observedContentType: CONTENT_TYPE,
    observedAssertionHash: '',
    secret: SECRET,
    expectedTenantId: TENANT,
    expectedAudience: AUDIENCE,
    ...overrides,
  };
}

describe('service-identity v2 — generate', () => {
  it('emits the full strict v2 header set including key, audience, query, content, assertion, and nonce', () => {
    const h = generateServiceIdentityHeadersV2({
      serviceName: SERVICE,
      secret: SECRET,
      tenantId: TENANT,
      method: METHOD,
      path: PATH,
      body: BODY,
      keyId: KEY_ID,
      audience: AUDIENCE,
      contentType: CONTENT_TYPE,
      nonce: NONCE,
    });
    expect(h['X-Service-Identity']).toBe(SERVICE);
    expect(h['X-Service-Sig-Version']).toBe('v2');
    expect(h['X-Service-Method']).toBe('POST');
    expect(h['X-Service-Path']).toBe(PATH);
    expect(h['X-Service-Body-Hash']).toBe(BODY_HASH);
    expect(h['X-Service-Key-Id']).toBe(KEY_ID);
    expect(h['X-Service-Audience']).toBe(AUDIENCE);
    expect(h['X-Service-Query-Hash']).toBe(EMPTY_QUERY_HASH);
    expect(h['X-Service-Content-Type']).toBe(CONTENT_TYPE);
    expect(h['X-Service-Assertion-Hash']).toBe('');
    expect(h['X-Service-Nonce']).toBe(NONCE);
    expect(h['X-Service-Effective-Tenant-ID']).toBe(TENANT);
    expect(h['X-Service-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(h['X-Service-Timestamp'])).not.toBeNaN();
  });

  it('uppercases method in canonical even if caller passed lowercase', () => {
    const h = generateServiceIdentityHeadersV2({
      serviceName: SERVICE,
      secret: SECRET,
      tenantId: TENANT,
      method: 'post',
      path: PATH,
      body: BODY,
      keyId: KEY_ID,
      audience: AUDIENCE,
      nonce: NONCE,
    });
    expect(h['X-Service-Method']).toBe('POST');
  });

  it('emits sha256("") for empty body — empty body still binds cryptographically', () => {
    const h = generateServiceIdentityHeadersV2({
      serviceName: SERVICE,
      secret: SECRET,
      tenantId: TENANT,
      method: 'GET',
      path: '/health',
      body: '',
      keyId: KEY_ID,
      audience: 'health',
      nonce: NONCE,
    });
    expect(h['X-Service-Body-Hash']).toBe(createHash('sha256').update('').digest('hex'));
  });
});

describe('service-identity v2 — verify (round-trip)', () => {
  function freshHeaders(): ReturnType<typeof generateServiceIdentityHeadersV2> {
    return fullHeaders();
  }

  it('round-trips successfully when receiver observes identical method/path/body', () => {
    const h = freshHeaders();
    expect(verifyServiceIdentityV2(verifyArgs(h))).toBe(true);
  });

  it('rejects when observed body differs from signed body (tamper detection)', () => {
    const h = freshHeaders();
    expect(verifyServiceIdentityV2(verifyArgs(h, { observedBody: BODY + ' tampered' }))).toBe(
      false,
    );
  });

  it('rejects when observed method differs from signed method', () => {
    const h = freshHeaders();
    expect(verifyServiceIdentityV2(verifyArgs(h, { observedMethod: 'GET' }))).toBe(false);
  });

  it('rejects when observed path differs from signed path', () => {
    const h = freshHeaders();
    expect(verifyServiceIdentityV2(verifyArgs(h, { observedPath: '/admin' }))).toBe(false);
  });

  it('rejects when expected tenantId differs from signed tenantId', () => {
    const h = freshHeaders();
    expect(
      verifyServiceIdentityV2(
        verifyArgs(h, { expectedTenantId: '22222222-2222-4222-8222-222222222222' }),
      ),
    ).toBe(false);
  });

  it('rejects when timestamp is older than maxAgeMs (replay window)', () => {
    const oldTimestamp = new Date(Date.now() - SERVICE_IDENTITY_MAX_AGE_MS - 1000).toISOString();
    // Forge a signature with the old timestamp using the same secret so we
    // verify the rejection comes from the timestamp check, not from HMAC.
    const canonical = [
      'v2',
      oldTimestamp,
      SERVICE,
      'POST',
      PATH,
      BODY_HASH,
      TENANT,
      KEY_ID,
      AUDIENCE,
      EMPTY_QUERY_HASH,
      CONTENT_TYPE,
      TENANT,
      '',
      NONCE,
    ].join('\n');
    const sig = createHmac('sha256', SECRET).update(canonical).digest('hex');
    expect(
      verifyServiceIdentityV2({
        serviceName: SERVICE,
        timestamp: oldTimestamp,
        signature: sig,
        method: 'POST',
        path: PATH,
        bodyHash: BODY_HASH,
        keyId: KEY_ID,
        audience: AUDIENCE,
        queryHash: EMPTY_QUERY_HASH,
        contentType: CONTENT_TYPE,
        assertionHash: '',
        nonce: NONCE,
        effectiveTenantId: TENANT,
        observedMethod: 'POST',
        observedPath: PATH,
        observedBody: BODY,
        observedQuery: '',
        observedContentType: CONTENT_TYPE,
        observedAssertionHash: '',
        secret: SECRET,
        expectedTenantId: TENANT,
        expectedAudience: AUDIENCE,
      }),
    ).toBe(false);
  });

  it('rejects when secret differs (HMAC mismatch)', () => {
    const h = freshHeaders();
    expect(verifyServiceIdentityV2(verifyArgs(h, { secret: 'wrong-secret' }))).toBe(false);
  });
});

describe('service-identity unified verifier (verifyServiceIdentityRequest)', () => {
  it('verifies v2 headers when X-Service-Sig-Version=v2', () => {
    const h = fullHeaders();
    const outcome = verifyServiceIdentityRequest({
      headers: {
        'x-service-identity': h['X-Service-Identity'],
        'x-service-timestamp': h['X-Service-Timestamp'],
        'x-service-signature': h['X-Service-Signature'],
        'x-service-sig-version': h['X-Service-Sig-Version'],
        'x-service-method': h['X-Service-Method'],
        'x-service-path': h['X-Service-Path'],
        'x-service-body-hash': h['X-Service-Body-Hash'],
        'x-service-key-id': h['X-Service-Key-Id'],
        'x-service-audience': h['X-Service-Audience'],
        'x-service-query-hash': h['X-Service-Query-Hash'],
        'x-service-content-type': h['X-Service-Content-Type'],
        'x-service-assertion-hash': h['X-Service-Assertion-Hash'],
        'x-service-nonce': h['X-Service-Nonce'],
        'x-service-effective-tenant-id': h['X-Service-Effective-Tenant-ID'],
      },
      observedMethod: METHOD,
      observedPath: PATH,
      observedBody: BODY,
      observedQuery: '',
      observedContentType: CONTENT_TYPE,
      observedAssertionHash: '',
      keyring: KEYRING,
      expectedTenantId: TENANT,
      expectedAudience: AUDIENCE,
    });
    expect(outcome).toMatchObject({
      valid: true,
      version: 'v2',
      serviceName: SERVICE,
      keyId: KEY_ID,
      audience: AUDIENCE,
      effectiveTenantId: TENANT,
      nonce: NONCE,
    });
  });

  it('rejects v1-shaped requests when sig-version header is absent', () => {
    const v1 = generateServiceIdentityHeaders(SERVICE, SECRET, TENANT);
    const outcome = verifyServiceIdentityRequest({
      headers: {
        'x-service-identity': v1['X-Service-Identity'],
        'x-service-timestamp': v1['X-Service-Timestamp'],
        'x-service-signature': v1['X-Service-Signature'],
      },
      observedMethod: 'POST',
      observedPath: PATH,
      observedBody: BODY,
      keyring: KEYRING,
      expectedTenantId: TENANT,
    });
    expect(outcome).toEqual({ valid: false, reason: 'unknown-version' });
  });

  it('rejects unknown sig-version with reason=unknown-version', () => {
    const v1 = generateServiceIdentityHeaders(SERVICE, SECRET, TENANT);
    const outcome = verifyServiceIdentityRequest({
      headers: {
        'x-service-identity': v1['X-Service-Identity'],
        'x-service-timestamp': v1['X-Service-Timestamp'],
        'x-service-signature': v1['X-Service-Signature'],
        'x-service-sig-version': 'v3-future',
      },
      observedMethod: 'POST',
      observedPath: PATH,
      observedBody: BODY,
      keyring: KEYRING,
      expectedTenantId: TENANT,
    });
    expect(outcome).toEqual({ valid: false, reason: 'unknown-version' });
  });

  it('rejects v2 with missing extra headers as missing-headers', () => {
    const h = fullHeaders();
    const outcome = verifyServiceIdentityRequest({
      headers: {
        'x-service-identity': h['X-Service-Identity'],
        'x-service-timestamp': h['X-Service-Timestamp'],
        'x-service-signature': h['X-Service-Signature'],
        'x-service-sig-version': 'v2',
        // intentionally omit method, path, body-hash
      },
      observedMethod: METHOD,
      observedPath: PATH,
      observedBody: BODY,
      keyring: KEYRING,
      expectedTenantId: TENANT,
    });
    expect(outcome).toEqual({ valid: false, reason: 'missing-headers' });
  });

  it('rejects when core headers are missing entirely', () => {
    const outcome = verifyServiceIdentityRequest({
      headers: {},
      observedMethod: METHOD,
      observedPath: PATH,
      observedBody: BODY,
      secret: SECRET,
      expectedTenantId: TENANT,
    });
    expect(outcome).toEqual({ valid: false, reason: 'missing-headers' });
  });

  it('reports invalid-hmac on tampered v2 signature', () => {
    const h = fullHeaders();
    const outcome = verifyServiceIdentityRequest({
      headers: {
        'x-service-identity': h['X-Service-Identity'],
        'x-service-timestamp': h['X-Service-Timestamp'],
        'x-service-signature': '0'.repeat(64),
        'x-service-sig-version': 'v2',
        'x-service-method': h['X-Service-Method'],
        'x-service-path': h['X-Service-Path'],
        'x-service-body-hash': h['X-Service-Body-Hash'],
        'x-service-key-id': h['X-Service-Key-Id'],
        'x-service-audience': h['X-Service-Audience'],
        'x-service-query-hash': h['X-Service-Query-Hash'],
        'x-service-content-type': h['X-Service-Content-Type'],
        'x-service-assertion-hash': h['X-Service-Assertion-Hash'],
        'x-service-nonce': h['X-Service-Nonce'],
        'x-service-effective-tenant-id': h['X-Service-Effective-Tenant-ID'],
      },
      observedMethod: METHOD,
      observedPath: PATH,
      observedBody: BODY,
      observedQuery: '',
      observedContentType: CONTENT_TYPE,
      observedAssertionHash: '',
      keyring: KEYRING,
      expectedTenantId: TENANT,
      expectedAudience: AUDIENCE,
    });
    expect(outcome).toEqual({ valid: false, reason: 'invalid-hmac' });
  });

  it('accepts previous keyring entries for verification but not disabled keys', () => {
    const h = fullHeaders();
    const baseArgs = {
      headers: {
        'x-service-identity': h['X-Service-Identity'],
        'x-service-timestamp': h['X-Service-Timestamp'],
        'x-service-signature': h['X-Service-Signature'],
        'x-service-sig-version': h['X-Service-Sig-Version'],
        'x-service-method': h['X-Service-Method'],
        'x-service-path': h['X-Service-Path'],
        'x-service-body-hash': h['X-Service-Body-Hash'],
        'x-service-key-id': h['X-Service-Key-Id'],
        'x-service-audience': h['X-Service-Audience'],
        'x-service-query-hash': h['X-Service-Query-Hash'],
        'x-service-content-type': h['X-Service-Content-Type'],
        'x-service-assertion-hash': h['X-Service-Assertion-Hash'],
        'x-service-nonce': h['X-Service-Nonce'],
        'x-service-effective-tenant-id': h['X-Service-Effective-Tenant-ID'],
      },
      observedMethod: METHOD,
      observedPath: PATH,
      observedBody: BODY,
      observedQuery: '',
      observedContentType: CONTENT_TYPE,
      observedAssertionHash: '',
      expectedTenantId: TENANT,
      expectedAudiences: [AUDIENCE],
    };

    const [primaryKey] = KEYRING;
    if (!primaryKey) {
      throw new Error('KEYRING fixture must contain at least one key');
    }
    expect(
      verifyServiceIdentityRequest({
        ...baseArgs,
        keyring: [{ ...primaryKey, status: 'previous' as const }],
      }),
    ).toMatchObject({ valid: true, version: 'v2' });
    expect(
      verifyServiceIdentityRequest({
        ...baseArgs,
        keyring: [{ ...primaryKey, status: 'disabled' as const }],
      }),
    ).toEqual({ valid: false, reason: 'key-not-active' });
  });

  it('rejects audiences outside the receiver allowlist', () => {
    const h = fullHeaders();
    const outcome = verifyServiceIdentityRequest({
      headers: {
        'x-service-identity': h['X-Service-Identity'],
        'x-service-timestamp': h['X-Service-Timestamp'],
        'x-service-signature': h['X-Service-Signature'],
        'x-service-sig-version': h['X-Service-Sig-Version'],
        'x-service-method': h['X-Service-Method'],
        'x-service-path': h['X-Service-Path'],
        'x-service-body-hash': h['X-Service-Body-Hash'],
        'x-service-key-id': h['X-Service-Key-Id'],
        'x-service-audience': h['X-Service-Audience'],
        'x-service-query-hash': h['X-Service-Query-Hash'],
        'x-service-content-type': h['X-Service-Content-Type'],
        'x-service-assertion-hash': h['X-Service-Assertion-Hash'],
        'x-service-nonce': h['X-Service-Nonce'],
        'x-service-effective-tenant-id': h['X-Service-Effective-Tenant-ID'],
      },
      observedMethod: METHOD,
      observedPath: PATH,
      observedBody: BODY,
      observedQuery: '',
      observedContentType: CONTENT_TYPE,
      observedAssertionHash: '',
      keyring: KEYRING,
      expectedTenantId: TENANT,
      expectedAudiences: ['billing'],
    });

    expect(outcome).toEqual({ valid: false, reason: 'audience-not-allowed' });
  });
});

describe('service-identity v1 — deprecated path still verifies (transition window)', () => {
  it('round-trips a v1 signature through the v1 verifier', () => {
    const h = generateServiceIdentityHeaders(SERVICE, SECRET, TENANT);
    expect(
      verifyServiceIdentity(
        h['X-Service-Identity'],
        h['X-Service-Timestamp'],
        h['X-Service-Signature'],
        SECRET,
        TENANT,
      ),
    ).toBe(true);
  });

  it('rejects v1 signature when tenantId differs (HIGH-003 invariant preserved)', () => {
    const h = generateServiceIdentityHeaders(SERVICE, SECRET, TENANT);
    expect(
      verifyServiceIdentity(
        h['X-Service-Identity'],
        h['X-Service-Timestamp'],
        h['X-Service-Signature'],
        SECRET,
        '00000000-0000-4000-8000-000000000000',
      ),
    ).toBe(false);
  });
});

describe('service-identity #388 regression — verifier derives caller policy from the catalog', () => {
  // The deploy secret bootstrap (scripts/deploy/lib/required-env-secrets.sh)
  // mints a keyring entry carrying ONLY {kid,secret,status} — no callers /
  // audiences. Regression #388 shipped that shape while resolveVerificationKey
  // still required INLINE callers (`!entry.callers || …`), so EVERY gateway→
  // subgraph call (every login) was rejected `caller-not-allowed`. The fixtures
  // above ALWAYS set callers/audiences, so the production keyring shape was never
  // exercised — this block is the bridge test that pins the fix.
  const BOOTSTRAP_KEYRING = [{ kid: KEY_ID, secret: SECRET, status: 'active' as const }];

  function requestHeaders(
    overrides: Partial<{ serviceName: string; audience: string }> = {},
  ): Record<string, string> {
    const h = generateServiceIdentityHeadersV2({
      serviceName: overrides.serviceName ?? SERVICE, // 'gateway-api' — a catalog caller
      secret: SECRET,
      tenantId: TENANT,
      method: METHOD,
      path: PATH,
      body: BODY,
      keyId: KEY_ID,
      audience: overrides.audience ?? AUDIENCE, // 'farm'
      contentType: CONTENT_TYPE,
      nonce: NONCE,
    });
    return {
      'x-service-identity': h['X-Service-Identity'],
      'x-service-timestamp': h['X-Service-Timestamp'],
      'x-service-signature': h['X-Service-Signature'],
      'x-service-sig-version': h['X-Service-Sig-Version'],
      'x-service-method': h['X-Service-Method'],
      'x-service-path': h['X-Service-Path'],
      'x-service-body-hash': h['X-Service-Body-Hash'],
      'x-service-key-id': h['X-Service-Key-Id'],
      'x-service-audience': h['X-Service-Audience'],
      'x-service-query-hash': h['X-Service-Query-Hash'],
      'x-service-content-type': h['X-Service-Content-Type'],
      'x-service-assertion-hash': h['X-Service-Assertion-Hash'],
      'x-service-nonce': h['X-Service-Nonce'],
      'x-service-effective-tenant-id': h['X-Service-Effective-Tenant-ID'],
    };
  }

  function verify(
    headers: Record<string, string>,
    overrides: Partial<Parameters<typeof verifyServiceIdentityRequest>[0]> = {},
  ): ReturnType<typeof verifyServiceIdentityRequest> {
    return verifyServiceIdentityRequest({
      headers,
      observedMethod: METHOD,
      observedPath: PATH,
      observedBody: BODY,
      observedQuery: '',
      observedContentType: CONTENT_TYPE,
      observedAssertionHash: '',
      keyring: BOOTSTRAP_KEYRING,
      expectedTenantId: TENANT,
      expectedAudience: AUDIENCE,
      ...overrides,
    });
  }

  it('ACCEPTS a catalog caller against a policy-less keyring entry (the #388 fix)', () => {
    // gateway-api → farm, with a keyring entry that has NO callers/audiences.
    // Pre-fix: caller-not-allowed. Post-fix: the allowlist is derived from the
    // catalog (gateway-api ∈ serviceIdentityCallers) so the call verifies.
    const outcome = verify(requestHeaders());
    expect(outcome).toMatchObject({ valid: true, version: 'v2', serviceName: SERVICE });
  });

  it('REJECTS an unknown caller not in the catalog allowlist (stays fail-closed)', () => {
    // 'evil-service' signs with a VALID HMAC (it holds the shared secret) but is
    // not a catalogued caller → rejected at the caller stage, before the HMAC.
    const outcome = verify(requestHeaders({ serviceName: 'evil-service' }));
    expect(outcome).toEqual({ valid: false, reason: 'caller-not-allowed' });
  });

  it('still enforces the per-receiver audience via matchesExpectedAudience', () => {
    // policy-less entry, valid catalog caller, but addressed to the wrong
    // receiver → audience-not-allowed. The real per-service audience check is
    // unchanged by removing the redundant keyring-audiences denial.
    const outcome = verify(requestHeaders(), { expectedAudience: 'auth' });
    expect(outcome).toEqual({ valid: false, reason: 'audience-not-allowed' });
  });

  it('honors an EXPLICIT entry.callers list over the catalog fallback', () => {
    // farm-service IS a catalog caller, but this entry pins callers=[gateway-api]
    // — an explicit (operator-tightened / event-store all-tenants) list must win,
    // so farm-service is rejected even though the catalog would allow it.
    const explicitKeyring = [
      { kid: KEY_ID, secret: SECRET, status: 'active' as const, callers: ['gateway-api'] },
    ];
    const outcome = verify(requestHeaders({ serviceName: 'farm-service' }), {
      keyring: explicitKeyring,
    });
    expect(outcome).toEqual({ valid: false, reason: 'caller-not-allowed' });
  });
});

describe('serializeServiceIdentityBodyForHash (shared SSoT for guard + middleware)', () => {
  it('prefers raw wire bytes (req.rawBody) even when req.body re-stringifies differently', () => {
    // The sender signed these exact bytes (note the wire whitespace):
    const wireBytes = '{"a": 1, "b": 2}';
    // V8 re-serializes the parsed object to DIFFERENT bytes (whitespace dropped):
    const parsed = JSON.parse(wireBytes) as Record<string, number>;
    expect(JSON.stringify(parsed)).not.toBe(wireBytes); // proves the divergence exists

    const out = serializeServiceIdentityBodyForHash({
      rawBody: Buffer.from(wireBytes, 'utf8'),
      body: parsed,
    });
    expect(Buffer.isBuffer(out)).toBe(true);
    expect((out as Buffer).toString('utf8')).toBe(wireBytes);
    // sha256(out) therefore matches the sender's sha256(wireBytes)
    expect(createHash('sha256').update(out).digest('hex')).toBe(
      createHash('sha256').update(wireBytes).digest('hex'),
    );
  });

  it('falls back to JSON.stringify(body) when rawBody is absent (backward-compatible)', () => {
    const body = { a: 1 };
    expect(serializeServiceIdentityBodyForHash({ body })).toBe(JSON.stringify(body));
  });

  it('returns the string body verbatim, and "" for null/undefined', () => {
    expect(serializeServiceIdentityBodyForHash({ body: 'raw-string' })).toBe('raw-string');
    expect(serializeServiceIdentityBodyForHash({ body: null })).toBe('');
    expect(serializeServiceIdentityBodyForHash({})).toBe('');
  });
});
