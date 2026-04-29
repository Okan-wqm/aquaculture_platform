/**
 * Platform-wide invariant — CIRCUIT-LOW-001:
 *
 * Cross-service health-probe fetches in admin-api MUST run through
 * the canonical CircuitBreakerService. A regression that strips the
 * `circuitBreaker.execute(...)` wrapper would silently re-introduce
 * the unbreakered-fetch class CIRCUIT-LOW-001 flagged.
 *
 * # Why this lives in tests/invariants/
 *
 * The breaker's value is invisible at code review unless the
 * reviewer specifically looks for it. The fetch() call shape and
 * the breaker.execute() shape are both reasonable-looking patterns
 * — only a source-level invariant catches a regression to the
 * unwrapped form before merge.
 *
 * # What this spec asserts
 *
 *   1. system-metrics.service.ts and performance-monitoring.service.ts
 *      both import CircuitBreakerService from the canonical
 *      `@aquaculture/backend-common/resilience` barrel.
 *   2. Both wrap their `fetch(endpoint.url, ...)` calls in
 *      `this.circuitBreaker.execute(...)` (the canonical execution
 *      shape).
 *   3. Neither file contains a bare `await fetch(` call site
 *      OUTSIDE a `circuitBreaker.execute` block. (The bare fetch
 *      is permitted INSIDE the execute's `fn:` lambda — that's
 *      where the breaker wraps it.)
 *
 * Closes: docs/reviews/circuit-breaker-auditor/2026-04-28-core-platform-review.md#CIRCUIT-LOW-001
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const WATCHED_BREAKERED_FETCH_SITES = [
  'apps/admin-api-service/src/metrics/system-metrics.service.ts',
  'apps/admin-api-service/src/system-management/services/performance-monitoring.service.ts',
] as const;

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('CIRCUIT-LOW-001 — admin-api health-probe breaker invariant', () => {
  it.each(WATCHED_BREAKERED_FETCH_SITES)(
    '%s imports CircuitBreakerService from the canonical resilience barrel',
    (path) => {
      const src = read(path);
      expect(src).toMatch(
        /import\s*{[^}]*CircuitBreakerService[^}]*}\s*from\s*['"]@aquaculture\/backend-common\/resilience['"]/,
      );
    },
  );

  it.each(WATCHED_BREAKERED_FETCH_SITES)(
    '%s wraps the cross-service fetch in circuitBreaker.execute(...)',
    (path) => {
      const src = read(path);
      expect(src).toMatch(/this\.circuitBreaker\.execute\s*</);
    },
  );

  it.each(WATCHED_BREAKERED_FETCH_SITES)(
    '%s admits no bare unwrapped fetch() call outside an execute() block',
    (path) => {
      const src = read(path);
      // Locate every `fetch(` call site. Then for each one, walk
      // back the preceding window for an `execute(` opener — if
      // present, the fetch is wrapped. If not, the fetch is bare
      // and the test fails.
      const fetchSites = [...src.matchAll(/\bfetch\s*\(/g)];
      const bareSites: number[] = [];

      for (const match of fetchSites) {
        const at = match.index ?? 0;
        const window = src.slice(Math.max(0, at - 1500), at);
        // The execute() opener must be followed by an arrow lambda
        // containing the fetch — `fn: async () => { ... fetch(`
        // The window cap of 1500 chars covers a reasonable
        // execute-block prelude (options, types) without false-
        // matching unrelated execute(...) calls elsewhere in the
        // file.
        const wrappedByExecute =
          /circuitBreaker\.execute\s*<[^>]*>\s*\(\s*{[\s\S]*?fn\s*:\s*async\s*\(\s*\)\s*=>\s*{/.test(
            window,
          );
        if (!wrappedByExecute) {
          bareSites.push(at);
        }
      }
      expect(bareSites).toEqual([]);
    },
  );

  it('admin-api app.module.ts imports CircuitBreakerModule', () => {
    const src = read('apps/admin-api-service/src/app.module.ts');
    expect(src).toMatch(
      /import\s*{[^}]*CircuitBreakerModule[^}]*}\s*from\s*['"]@aquaculture\/backend-common\/resilience['"]/,
    );
    // Module is referenced in the imports[] array of the AppModule.
    expect(src).toMatch(/CircuitBreakerModule\s*,/);
  });
});
