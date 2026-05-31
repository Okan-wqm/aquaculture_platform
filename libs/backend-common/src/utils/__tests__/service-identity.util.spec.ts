/**
 * Unit tests for service-identity.util — v1 (deprecated) + v2 (current).
 *
 * Closes: docs/reviews/auth-security-expert/2026-04-28-core-platform-review.md#SEC-CRITICAL-001
 * Closes: docs/reviews/security-reviewer/2026-04-28-core-platform-review.md#SECREV-CRITICAL-001
 */

import {
  SERVICE_IDENTITY_MAX_AGE_MS,
  generateServiceIdentityHeaders,
  generateServiceIdentityHeadersV2,
  verifyServiceIdentity,
  verifyServiceIdentityRequest,
  verifyServiceIdentityV2,
} from '../service-identity.util';
import { createHash, createHmac } from 'crypto';

const SECRET = 'test-internal-secret-do-not-use-in-prod-this-is-only-a-fixture';
const SERVICE = 'gateway-api';
const TENANT = '11111111-1111-4111-8111-111111111111';
const PATH = '/graphql';
const METHOD = 'POST';
const BODY = '{"query":"{ farms { id } }"}';
const BODY_HASH = createHash('sha256').update(BODY).digest('hex');
const EMPTY_ASSERTION_HASH = createHash('sha256').update('').digest('hex');

describe('service-identity v2 — generate', () => {
  it('emits all v2 headers including Sig-Version, Method, Path, Body-Hash, Assertion-Hash', () => {
    const h = generateServiceIdentityHeadersV2({
      serviceName: SERVICE,
      secret: SECRET,
      tenantId: TENANT,
      method: METHOD,
      path: PATH,
      body: BODY,
    });
    expect(h['X-Service-Identity']).toBe(SERVICE);
    expect(h['X-Service-Sig-Version']).toBe('v2');
    expect(h['X-Service-Method']).toBe('POST');
    expect(h['X-Service-Path']).toBe(PATH);
    expect(h['X-Service-Body-Hash']).toBe(BODY_HASH);
    expect(h['X-Service-Assertion-Hash']).toBe(EMPTY_ASSERTION_HASH);
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
    });
    expect(h['X-Service-Body-Hash']).toBe(
      createHash('sha256').update('').digest('hex'),
    );
  });
});

describe('service-identity v2 — verify (round-trip)', () => {
  function freshHeaders() {
    return generateServiceIdentityHeadersV2({
      serviceName: SERVICE,
      secret: SECRET,
      tenantId: TENANT,
      method: METHOD,
      path: PATH,
      body: BODY,
    });
  }

  it('round-trips successfully when receiver observes identical method/path/body', () => {
    const h = freshHeaders();
    expect(
      verifyServiceIdentityV2({
        serviceName: h['X-Service-Identity'],
        timestamp: h['X-Service-Timestamp'],
        signature: h['X-Service-Signature'],
        method: h['X-Service-Method'],
        path: h['X-Service-Path'],
        bodyHash: h['X-Service-Body-Hash'],
        assertionHash: h['X-Service-Assertion-Hash'],
        observedMethod: METHOD,
        observedPath: PATH,
        observedBody: BODY,
        observedAssertionHash: EMPTY_ASSERTION_HASH,
        secret: SECRET,
        expectedTenantId: TENANT,
      }),
    ).toBe(true);
  });

  it('rejects when observed body differs from signed body (tamper detection)', () => {
    const h = freshHeaders();
    expect(
      verifyServiceIdentityV2({
        serviceName: h['X-Service-Identity'],
        timestamp: h['X-Service-Timestamp'],
        signature: h['X-Service-Signature'],
        method: h['X-Service-Method'],
        path: h['X-Service-Path'],
        bodyHash: h['X-Service-Body-Hash'],
        assertionHash: h['X-Service-Assertion-Hash'],
        observedMethod: METHOD,
        observedPath: PATH,
        observedBody: BODY + ' tampered',
        observedAssertionHash: EMPTY_ASSERTION_HASH,
        secret: SECRET,
        expectedTenantId: TENANT,
      }),
    ).toBe(false);
  });

  it('rejects when observed method differs from signed method', () => {
    const h = freshHeaders();
    expect(
      verifyServiceIdentityV2({
        serviceName: h['X-Service-Identity'],
        timestamp: h['X-Service-Timestamp'],
        signature: h['X-Service-Signature'],
        method: h['X-Service-Method'],
        path: h['X-Service-Path'],
        bodyHash: h['X-Service-Body-Hash'],
        assertionHash: h['X-Service-Assertion-Hash'],
        observedMethod: 'GET',
        observedPath: PATH,
        observedBody: BODY,
        observedAssertionHash: EMPTY_ASSERTION_HASH,
        secret: SECRET,
        expectedTenantId: TENANT,
      }),
    ).toBe(false);
  });

  it('rejects when observed path differs from signed path', () => {
    const h = freshHeaders();
    expect(
      verifyServiceIdentityV2({
        serviceName: h['X-Service-Identity'],
        timestamp: h['X-Service-Timestamp'],
        signature: h['X-Service-Signature'],
        method: h['X-Service-Method'],
        path: h['X-Service-Path'],
        bodyHash: h['X-Service-Body-Hash'],
        assertionHash: h['X-Service-Assertion-Hash'],
        observedMethod: METHOD,
        observedPath: '/admin',
        observedBody: BODY,
        observedAssertionHash: EMPTY_ASSERTION_HASH,
        secret: SECRET,
        expectedTenantId: TENANT,
      }),
    ).toBe(false);
  });

  it('rejects when expected tenantId differs from signed tenantId', () => {
    const h = freshHeaders();
    expect(
      verifyServiceIdentityV2({
        serviceName: h['X-Service-Identity'],
        timestamp: h['X-Service-Timestamp'],
        signature: h['X-Service-Signature'],
        method: h['X-Service-Method'],
        path: h['X-Service-Path'],
        bodyHash: h['X-Service-Body-Hash'],
        assertionHash: h['X-Service-Assertion-Hash'],
        observedMethod: METHOD,
        observedPath: PATH,
        observedBody: BODY,
        observedAssertionHash: EMPTY_ASSERTION_HASH,
        secret: SECRET,
        expectedTenantId: '22222222-2222-4222-8222-222222222222',
      }),
    ).toBe(false);
  });

  it('rejects when timestamp is older than maxAgeMs (replay window)', () => {
    const oldTimestamp = new Date(
      Date.now() - SERVICE_IDENTITY_MAX_AGE_MS - 1000,
    ).toISOString();
    // Forge a signature with the old timestamp using the same secret so we
    // verify the rejection comes from the timestamp check, not from HMAC.
    const canonical = [
      'v2',
      oldTimestamp,
      SERVICE,
      'POST',
      PATH,
      BODY_HASH,
      EMPTY_ASSERTION_HASH,
      TENANT,
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
        assertionHash: EMPTY_ASSERTION_HASH,
        observedMethod: 'POST',
        observedPath: PATH,
        observedBody: BODY,
        observedAssertionHash: EMPTY_ASSERTION_HASH,
        secret: SECRET,
        expectedTenantId: TENANT,
      }),
    ).toBe(false);
  });

  it('rejects when secret differs (HMAC mismatch)', () => {
    const h = freshHeaders();
    expect(
      verifyServiceIdentityV2({
        serviceName: h['X-Service-Identity'],
        timestamp: h['X-Service-Timestamp'],
        signature: h['X-Service-Signature'],
        method: h['X-Service-Method'],
        path: h['X-Service-Path'],
        bodyHash: h['X-Service-Body-Hash'],
        assertionHash: h['X-Service-Assertion-Hash'],
        observedMethod: METHOD,
        observedPath: PATH,
        observedBody: BODY,
        observedAssertionHash: EMPTY_ASSERTION_HASH,
        secret: 'wrong-secret',
        expectedTenantId: TENANT,
      }),
    ).toBe(false);
  });
});

describe('service-identity unified verifier (verifyServiceIdentityRequest)', () => {
  it('verifies v2 headers when X-Service-Sig-Version=v2', () => {
    const h = generateServiceIdentityHeadersV2({
      serviceName: SERVICE,
      secret: SECRET,
      tenantId: TENANT,
      method: METHOD,
      path: PATH,
      body: BODY,
    });
    const outcome = verifyServiceIdentityRequest({
      headers: {
        'x-service-identity': h['X-Service-Identity'],
        'x-service-timestamp': h['X-Service-Timestamp'],
        'x-service-signature': h['X-Service-Signature'],
        'x-service-sig-version': h['X-Service-Sig-Version'],
        'x-service-method': h['X-Service-Method'],
        'x-service-path': h['X-Service-Path'],
        'x-service-body-hash': h['X-Service-Body-Hash'],
        'x-service-assertion-hash': h['X-Service-Assertion-Hash'],
      },
      observedMethod: METHOD,
      observedPath: PATH,
      observedBody: BODY,
      secret: SECRET,
      expectedTenantId: TENANT,
    });
    expect(outcome).toEqual({ valid: true, version: 'v2' });
  });

  it('falls back to v1 when sig-version header is absent (transition window)', () => {
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
      secret: SECRET,
      expectedTenantId: TENANT,
    });
    expect(outcome).toEqual({ valid: true, version: 'v1' });
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
      secret: SECRET,
      expectedTenantId: TENANT,
    });
    expect(outcome).toEqual({ valid: false, reason: 'unknown-version' });
  });

  it('rejects v2 with missing extra headers as missing-headers', () => {
    const h = generateServiceIdentityHeadersV2({
      serviceName: SERVICE,
      secret: SECRET,
      tenantId: TENANT,
      method: METHOD,
      path: PATH,
      body: BODY,
    });
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
      secret: SECRET,
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
    const h = generateServiceIdentityHeadersV2({
      serviceName: SERVICE,
      secret: SECRET,
      tenantId: TENANT,
      method: METHOD,
      path: PATH,
      body: BODY,
    });
    const outcome = verifyServiceIdentityRequest({
      headers: {
        'x-service-identity': h['X-Service-Identity'],
        'x-service-timestamp': h['X-Service-Timestamp'],
        'x-service-signature': '0'.repeat(64),
        'x-service-sig-version': 'v2',
        'x-service-method': h['X-Service-Method'],
        'x-service-path': h['X-Service-Path'],
        'x-service-body-hash': h['X-Service-Body-Hash'],
        'x-service-assertion-hash': h['X-Service-Assertion-Hash'],
      },
      observedMethod: METHOD,
      observedPath: PATH,
      observedBody: BODY,
      secret: SECRET,
      expectedTenantId: TENANT,
    });
    expect(outcome).toEqual({ valid: false, reason: 'invalid-hmac' });
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
