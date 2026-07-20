/**
 * Platform-wide invariant — ADMIN-CRITICAL-014 / APA-289 (drift detector):
 *
 * The admin-api impersonation subsystem mints an `x-impersonation-token`
 * (hashed, IP-bound, time-boxed) but NOTHING in the request path consumes it:
 * the only reader is admin-api's own `GET /impersonation/sessions/validate`.
 * Actual cross-tenant SUPER_ADMIN access flows through a SEPARATE, unbound path
 * — the gateway's effective-tenant "act-as" (x-act-as-tenant -> HMAC-signed
 * effectiveTenantId) — which never checks for an active impersonation session.
 * That RC-11 split-brain is the tracked finding ADMIN-CRITICAL-014 / APA-289;
 * its remediation (binding the token into the gateway act-as path) is a
 * cross-service change to the tenant-isolation trust boundary that needs
 * product/security sign-off and a real-Postgres/Redis integration test — see
 * docs/adr/046.
 *
 * # WHY this gate exists
 *
 * Until that reviewed binding lands, the current fail-SAFE reality is
 * "the token grants nothing". The blind-spot risk is that someone wires a
 * PARTIAL consumer (a gateway/middleware that starts trusting the token) WITHOUT
 * the full reviewed path — flipping the posture to fail-DANGEROUS
 * (an unverified credential that itself grants tenant-crossing access). This
 * invariant pins the current reality: the `x-impersonation-token` header is
 * referenced ONLY inside admin-api. The moment any other service/lib/web module
 * references it, this turns RED — forcing that change to go through the tracked
 * trust-boundary review and land WITH the enforcement + integration tests, not
 * as a silent half-binding.
 *
 * When APA-289 is genuinely remediated, this spec is updated as part of that PR
 * to encode the new (bound) contract.
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const TOKEN_HEADER = 'x-impersonation-token';
const OWNER_PREFIX = 'apps/admin-api-service/';

/**
 * Code files (repo-relative) that reference the impersonation token header.
 * Scoped to executable source (.ts/.tsx) — markdown that documents the APA-289
 * defect (audit findings, ADRs) legitimately names the header and is not a
 * request-path consumer.
 */
function codeFilesReferencingToken(): string[] {
  let out: string;
  try {
    // -F fixed-string, -l names-only, -i case-insensitive; pathspec limits the
    // scan to TypeScript source so prose in docs/*.md never counts.
    out = execSync(
      `git -C ${REPO_ROOT} grep -Fil ${TOKEN_HEADER} -- '*.ts' '*.tsx'`,
      { encoding: 'utf8' },
    );
  } catch (err) {
    // git grep exits 1 when there are zero matches.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
  return out.trim().split('\n').filter(Boolean);
}

describe('INVARIANT (ADMIN-CRITICAL-014 / APA-289): impersonation token has no consumer outside admin-api', () => {
  it('the x-impersonation-token header is referenced only within apps/admin-api-service (its owner)', () => {
    const files = codeFilesReferencingToken();

    // Sanity: the header must exist somewhere (admin-api owns it). If this drops
    // to zero the header was renamed/removed and this gate needs updating.
    expect(files.length).toBeGreaterThan(0);

    // This spec is itself a reference; exclude the invariant suite.
    const external = files.filter(
      (f) => !f.startsWith(OWNER_PREFIX) && !f.startsWith('tests/invariants/'),
    );

    // Any external reference means someone began consuming the impersonation
    // token in the request path. That MUST arrive through the tracked APA-289
    // trust-boundary review (docs/adr/046), not silently — so fail loudly here.
    expect(external).toEqual([]);
  });
});
