/**
 * Platform-wide invariant — SEC-CRITICAL-001 / SECREV-CRITICAL-001:
 *
 * Every signer of internal-service HTTP traffic MUST go through one of
 * the two canonical helpers in `libs/backend-common/src/utils/service-identity.util.ts`:
 *
 *   - `generateServiceIdentityHeadersV2`  (preferred — full method/path/body bind)
 *   - `generateServiceIdentityHeaders`    (deprecated v1 — kept for one release)
 *
 * Hand-rolled HMAC over the v1 canonical (`timestamp:service:tenantId`)
 * outside this util re-introduces the regression class the audit
 * captured: cross-endpoint replay + body-tampering on inter-service calls.
 *
 * # What this test enforces
 *
 *   1. The two generator exports exist.
 *   2. The unified verifier export `verifyServiceIdentityRequest` exists
 *      (single canonical entry point for receivers).
 *   3. No NEW grep hit appears matching the v1 canonical-string shape
 *      `${timestamp}:${serviceName}:${tenantId}` outside the canonical
 *      util. A small allowlist captures the legitimate hand-rolled HMAC
 *      paths that exist for unrelated protocols (TOTP, password reset,
 *      Stripe webhook) — each entry is justified inline.
 *
 * # Why source-level invariant
 *
 * The receiver guard is ONE place; the generator helpers are TWO. A
 * source-level grep is the cheapest reliable check. Catches:
 *   - copy-pasted v1 canonical string into a new caller
 *   - someone re-introducing the deprecated shape after the W0.A-finalize
 *     removal
 *   - a fresh agent generating signature code from training data instead
 *     of using the canonical helper
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const UTIL_PATH = 'libs/backend-common/src/utils/service-identity.util.ts';

/**
 * Files that legitimately use HMAC-SHA256 for protocols OTHER than
 * service-identity. Each entry is allowed to contain `createHmac` calls
 * but is asserted NOT to use the v1 service-identity canonical string
 * shape `${timestamp}:${serviceName}:${tenantId}`.
 */
const HMAC_ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: 'libs/backend-common/src/utils/hmac-tenant-hash.util.ts',
    reason: 'Tenant-schema HMAC for log redaction. Different protocol, no service-identity overlap.',
  },
  {
    path: 'libs/backend-common/src/auth/password.util.ts',
    reason: 'Password pepper HMAC for credential storage. Different protocol.',
  },
  {
    path: 'apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts',
    reason: 'Stripe webhook signature verification — Stripe-defined protocol, distinct from internal service identity.',
  },
  {
    path: 'apps/admin-api-service/src/auth/password-reset.controller.ts',
    reason: 'Password-reset token HMAC. Different protocol, no inter-service exposure.',
  },
  {
    path: 'apps/auth-service/src/modules/authentication/services/mfa.service.ts',
    reason: 'TOTP RFC 6238 HMAC-SHA1 for one-time codes. Different protocol.',
  },
  {
    path: 'apps/gateway-api/src/guards/strategies/api-key-auth.strategy.ts',
    reason: 'External API-key HMAC for tenant-issued API keys. Different protocol from internal-service identity.',
  },
  {
    path: 'apps/gateway-api/src/middleware/strip-internal-headers.middleware.ts',
    reason: 'Strip-vs-trust gate using HMAC(serviceName, secret) only. Narrower contract — proof-of-secret-possession; not a SEC-CRITICAL-001 surface.',
  },
];

describe('INVARIANT (SEC-CRITICAL-001): service-identity canonical coverage', () => {
  it('exports both v1 (deprecated) and v2 generators from the canonical util', () => {
    const src = readFileSync(resolve(REPO_ROOT, UTIL_PATH), 'utf8');
    expect(src).toMatch(/export function generateServiceIdentityHeadersV2/);
    expect(src).toMatch(/export function generateServiceIdentityHeaders\b/);
    expect(src).toMatch(/export function verifyServiceIdentityRequest\b/);
    expect(src).toMatch(/export function verifyServiceIdentityV2\b/);
    expect(src).toMatch(/export function verifyServiceIdentity\b/);
  });

  it('the v2 canonical input binds method, path, and body-hash', () => {
    const src = readFileSync(resolve(REPO_ROOT, UTIL_PATH), 'utf8');
    // The function buildCanonicalV2 is internal but its body must list the
    // four bound fields for the regression check to be visible.
    expect(src).toMatch(/buildCanonicalV2/);
    expect(src).toMatch(/SIG_VERSION_V2/);
    // Sanity — the v2 header set includes the four extra headers.
    expect(src).toMatch(/'X-Service-Method'/);
    expect(src).toMatch(/'X-Service-Path'/);
    expect(src).toMatch(/'X-Service-Body-Hash'/);
    expect(src).toMatch(/'X-Service-Sig-Version'/);
  });

  it('no production code (outside the canonical util + allowlist) constructs the v1 canonical string shape', () => {
    // Pattern: any literal containing "${timestamp}:${serviceName}:${tenantId}"
    // — the exact v1 input. A tamperer reintroducing this shape would
    // emit it in a template literal exactly like the deprecated function.
    let grepOut: string;
    try {
      grepOut = execSync(
        `git -C ${REPO_ROOT} grep -lE '\\$\\{timestamp\\}:\\$\\{serviceName\\}:\\$\\{tenantId\\}' -- 'apps/**/*.ts' 'libs/**/*.ts' 'platform/**/*.ts' ':!**/__tests__/**' ':!**/*.spec.ts' ':!**/node_modules/**'`,
        { encoding: 'utf8' },
      );
    } catch (err) {
      const e = err as { status?: number };
      if (e.status === 1) {
        // No matches — the canonical util uses a different shape internally
        // (separated by newline + version prefix), so even it doesn't match.
        return;
      }
      throw err;
    }

    const offending = grepOut
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((p) => !p.endsWith(UTIL_PATH));

    if (offending.length > 0) {
      throw new Error(
        'New code uses the deprecated v1 service-identity canonical input ' +
          '(`${timestamp}:${serviceName}:${tenantId}`). Use generateServiceIdentityHeadersV2 ' +
          'or signedFetch from libs/backend-common instead.\nOffending files:\n  - ' +
          offending.join('\n  - '),
      );
    }
  });

  it('the HMAC allowlist documents every legitimate non-service-identity HMAC user', () => {
    // Every allowlist entry must reference a real file. Stale allowlist
    // entries are themselves a regression risk — they let a future delete
    // pass un-noticed.
    for (const entry of HMAC_ALLOWLIST) {
      try {
        readFileSync(resolve(REPO_ROOT, entry.path), 'utf8');
      } catch {
        throw new Error(
          `HMAC allowlist references non-existent file: ${entry.path}. ` +
            `Update the allowlist or remove the stale entry. Reason on file: ${entry.reason}`,
        );
      }
    }
  });
});
