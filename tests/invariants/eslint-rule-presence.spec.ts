/**
 * Platform-wide invariant — AUDIT-MEDIUM-005 + historical IDOR findings:
 *
 * The repo's ESLint config defines load-bearing lint rules that prevent
 * specific regression classes:
 *
 *   - `no-restricted-syntax::getRepository` — blocks the tenant-isolation
 *     bypass that caused the 2026-04 IDOR findings (AUDIT-HIGH-002/003/008).
 *   - `no-restricted-syntax::JWT_SECRET` — blocks reintroduction of the
 *     HS256 shared-secret vector closed in commit 7c076361
 *     (ADR-016 Phase B).
 *   - `no-restricted-imports::@aquaculture/backend-common` — keeps the
 *     root barrel split won by AUDIT-MEDIUM-005 phases 1-3.
 *
 * These rules were each added after a real incident. Losing any one of
 * them silently reopens the corresponding regression class.
 *
 * A2 (ESLint 8->9 flat config) MIGRATION NOTE: this invariant used to
 * JSON-parse `.eslintrc.json` and walk its `overrides[].rules`. That file is
 * gone — the policy now lives in the flat `eslint.config.mjs`. We assert
 * against the config SOURCE (not a resolved config) on purpose: ESLint loads
 * `eslint.config.mjs` via dynamic `import()`, which Jest cannot perform without
 * `--experimental-vm-modules`, so a resolve-based check would crash the fast
 * invariant shard. The DISTINCTIVE AST-selector substrings asserted below
 * (`callee.property.name='getRepository'`, `arguments.0.value='JWT_SECRET'`,
 * etc.) appear ONLY inside the rule's `selector` strings — never in the prose
 * `message` — so source-text presence is a faithful deletion/weakening guard.
 * The RESOLVED behaviour (which selectors apply to which zone, per-rule
 * severity, zero-drift vs the old eslintrc) is proven separately and live by
 * tools/lint-gates/eslintrc-flat-parity.spec.ts + lint-gates.spec.ts.
 *
 * What this invariant does NOT check:
 *   - Whether `nx affected -t lint` actually executes in CI (PROC-MEDIUM-006).
 *   - Per-zone gate consistency / selector counts (eslintrc-flat-parity owns it).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function loadFlatConfigSource(): string {
  return readFileSync(resolve(REPO_ROOT, 'eslint.config.mjs'), 'utf-8');
}

describe('INVARIANT: the flat eslint.config.mjs carries the load-bearing regression-guard rules', () => {
  const source = loadFlatConfigSource();

  describe('no-restricted-syntax', () => {
    it('blocks direct `getRepository()` calls (tenant-isolation bypass)', () => {
      expect(source).toContain("callee.property.name='getRepository'");
    });

    it('blocks reading `JWT_SECRET` via ConfigService.get()', () => {
      expect(source).toContain("callee.property.name='get'");
      expect(source).toContain("arguments.0.value='JWT_SECRET'");
    });

    it('blocks reading `JWT_SECRET` via ConfigService.getOrThrow()', () => {
      expect(source).toContain("callee.property.name='getOrThrow'");
    });

    it('blocks reading `process.env.JWT_SECRET`', () => {
      // both the dot-access and computed-access selectors must survive
      expect(source).toContain("property.name='JWT_SECRET'");
      expect(source).toContain("property.value='JWT_SECRET'");
    });
  });

  describe('no-restricted-imports', () => {
    it('blocks the `@aquaculture/backend-common` root barrel (AUDIT-MEDIUM-005)', () => {
      expect(source).toContain("name: '@aquaculture/backend-common'");
    });

    it('blocks the `@platform/backend-common` parity alias (AUDIT-MEDIUM-005)', () => {
      expect(source).toContain("name: '@platform/backend-common'");
    });
  });
});
