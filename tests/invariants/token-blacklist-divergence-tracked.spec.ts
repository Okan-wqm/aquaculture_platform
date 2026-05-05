/**
 * Platform-wide invariant — SEC-LOW-001:
 *
 * Until the SEC-MEDIUM-006-blocked merge of `TOKEN_BLACKLIST` (lib)
 * and `TOKEN_BLACKLIST_STORE` (gateway) lands, BOTH declaration
 * sites MUST carry cross-reference annotations pointing at each
 * other and at the SEC-LOW-001 / SEC-MEDIUM-006 finding IDs.
 *
 * # Why this lives in tests/invariants/
 *
 * The two divergent declarations are easy to "tidy" by deleting
 * the cross-reference comment. Without the comment the next
 * maintainer sees two unrelated symbols and may either duplicate
 * effort (refactoring one without the other) or accept the
 * divergence as canonical — losing the consolidation tracking.
 *
 * The invariant pins the cross-reference annotations on both
 * sites until the actual merge lands.
 *
 * # What this spec asserts
 *
 *   1. The canonical lib declaration mentions the gateway local
 *      site + the SEC-LOW-001 / SEC-MEDIUM-006 finding IDs.
 *   2. The gateway-local declaration mentions the canonical lib
 *      site + the SEC-LOW-001 / SEC-MEDIUM-006 finding IDs.
 *   3. Both still exist (sanity — the merge hasn't landed yet).
 *
 * Closes: docs/reviews/auth-security-expert/2026-04-28-core-platform-review.md#SEC-LOW-001
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const CANONICAL_PATH = 'libs/backend-common/src/security/interfaces/index.ts';
const GATEWAY_PATH =
  'apps/gateway-api/src/guards/redis-token-blacklist.store.ts';

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('SEC-LOW-001 — token-blacklist divergence tracked across both sites', () => {
  it('canonical libs declaration is present', () => {
    const src = read(CANONICAL_PATH);
    expect(src).toMatch(
      /export\s+const\s+TOKEN_BLACKLIST\s*=\s*['"`]TOKEN_BLACKLIST['"`]/,
    );
  });

  it('gateway-local TOKEN_BLACKLIST_STORE declaration is present', () => {
    const src = read(GATEWAY_PATH);
    expect(src).toMatch(
      /export\s+const\s+TOKEN_BLACKLIST_STORE\s*=\s*Symbol\(['"`]TOKEN_BLACKLIST_STORE['"`]\)/,
    );
  });

  it('canonical declaration mentions the gateway-local cross-reference + SEC-LOW-001 + SEC-MEDIUM-006', () => {
    const src = read(CANONICAL_PATH);
    // Find the TOKEN_BLACKLIST declaration's preceding docblock.
    const declMatch =
      /\/\*\*[\s\S]*?\*\/\s*export\s+const\s+TOKEN_BLACKLIST\s*=/.exec(src);
    expect(declMatch).not.toBeNull();
    const docblock = declMatch![0];
    expect(docblock).toMatch(/TOKEN_BLACKLIST_STORE/);
    expect(docblock).toMatch(/redis-token-blacklist\.store/);
    expect(docblock).toMatch(/SEC-LOW-001/);
    expect(docblock).toMatch(/SEC-MEDIUM-006/);
  });

  it('gateway-local declaration mentions the canonical cross-reference + SEC-LOW-001 + SEC-MEDIUM-006', () => {
    const src = read(GATEWAY_PATH);
    // Both the interface docblock + the const-symbol docblock
    // need a cross-reference. Probe the file as a whole.
    expect(src).toMatch(/canonical/i);
    expect(src).toMatch(/libs\/backend-common\/src\/security\/interfaces/);
    expect(src).toMatch(/TOKEN_BLACKLIST\b/);
    expect(src).toMatch(/SEC-LOW-001/);
    expect(src).toMatch(/SEC-MEDIUM-006/);
  });
});
