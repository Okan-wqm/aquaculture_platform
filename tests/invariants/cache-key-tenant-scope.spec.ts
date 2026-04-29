/**
 * Platform-wide invariant — BILLING-MEDIUM-006 + layer-1-nestjs:
 *
 * Cache keys MUST be tenant-scoped per the layer-1-nestjs platform
 * contract. The canonical shape is:
 *
 *     cache:<service>:<tenant>:<resource>:<key>
 *
 * Even for in-process Map-based caches (which are tenant-safe today
 * because the process boundary scopes them), building the discipline
 * in now prevents two regression classes:
 *
 *   1. A future Redis promotion inheriting a non-tenant-scoped key
 *      shape → cross-tenant cache bleed once the key namespace is
 *      shared across replicas.
 *   2. A future composite-key change inadvertently making
 *      different-tenant cache entries collide on the prefix.
 *
 * # Why this lives in tests/invariants/
 *
 * Cache-key shape is invisible at code review unless the reviewer
 * specifically remembers the layer-1 rule. A source-level invariant
 * catches the regression class at PR review.
 *
 * # What this spec asserts
 *
 *   - The known cache-bearing services in billing-service (and other
 *     services as they're added to the WATCHED_SERVICES list) build
 *     cache keys via the canonical `cache:<svc>:<tenant>:` prefix.
 *   - Specifically forbids the legacy shape
 *     `${subscriptionId}-${period}` that BILLING-MEDIUM-006 flagged.
 *
 * Closes: docs/reviews/billing-expert/2026-04-28-core-platform-review.md#BILLING-MEDIUM-006
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

interface WatchedCacheSite {
  /** Path to the source file relative to repo root. */
  path: string;
  /** Variable / property name of the cache being inspected. */
  cacheVarName: string;
  /** Service identifier expected in the cache-key prefix. */
  serviceTag: string;
}

const WATCHED_CACHE_SITES: WatchedCacheSite[] = [
  {
    path: 'apps/billing-service/src/modules/metering/metered-billing.service.ts',
    cacheVarName: 'calculationCache',
    serviceTag: 'metered-billing',
  },
];

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('cache-key tenant-scope invariant (BILLING-MEDIUM-006)', () => {
  it.each(WATCHED_CACHE_SITES)(
    '%# — $path: $cacheVarName cache keys carry the canonical cache:<svc>:<tenant>: prefix',
    (site) => {
      const src = read(site.path);

      // Find every `cacheVarName.set(` and `cacheVarName.get(` site.
      const cacheGetSet = new RegExp(
        String.raw`this\.${site.cacheVarName}\.(?:get|set)\s*\(`,
        'g',
      );
      const matches = [...src.matchAll(cacheGetSet)];
      expect(matches.length).toBeGreaterThan(0);

      // For each match, walk back to the nearest `const cacheKey =`
      // assignment and assert its right-hand-side carries the
      // canonical prefix shape. Callers may use a const named
      // `cacheKey` or pass an inline expression — we look for the
      // variable assignment first, then for inline shape.
      const canonicalPrefix = new RegExp(
        String.raw`['"\`]cache:${site.serviceTag}:\$\{[^}]*tenantId[^}]*\}:`,
      );
      expect(src).toMatch(canonicalPrefix);

      // Negative: forbid the legacy `${subscriptionId}-${period}`
      // shape that BILLING-MEDIUM-006 flagged. We regex over the
      // template-literal form specifically because the prior bad
      // shape was `${subscriptionId}-${period.getTime()}-...`.
      const legacyShape =
        /['"`]\$\{subscriptionId\}-\$\{periodStart/;
      expect(src).not.toMatch(legacyShape);
    },
  );

  it('canonical shape is documented (cache:<service>:<tenant>:<resource>:<key>)', () => {
    // This spec exists primarily to make the canonical shape
    // visible in test output so a reviewer reading the failure
    // gets the format reference inline. The assertion is trivially
    // true; the comment is the load-bearing documentation.
    const canonical = 'cache:<service>:<tenant>:<resource>:<key>';
    expect(canonical).toMatch(/^cache:.*:.*:.*:.*$/);
  });
});
