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
  // CIRCUIT-LOW-001 — admin-api cross-service health probes
  'apps/admin-api-service/src/metrics/system-metrics.service.ts',
  'apps/admin-api-service/src/system-management/services/performance-monitoring.service.ts',
  // CIRCUIT-LOW-002 — sensor-service IoT vendor + ai-service
  // cross-service fetches. Same Tier-1 cure as the admin-api
  // sites; same single SSoT for canonical-import + execute-wrap
  // assertions.
  'apps/sensor-service/src/sensor-type/channel-detection.service.ts',
  'apps/sensor-service/src/protocol/adapters/iot/http-rest.adapter.ts',
] as const;

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('CIRCUIT-LOW-001 / CIRCUIT-LOW-002 — cross-service fetch breaker invariant', () => {
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
      // Strip block + line comments so JSDoc / explanatory
      // comments referencing "fetch (" do not get flagged as
      // callsites. Full TS-grammar parsing is outside the
      // invariant's scope; this is good enough for the source
      // shapes the auditor flagged.
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ');

      // Locate every `fetch(` callsite. Each must have an
      // `this.circuitBreaker.execute` opener somewhere in the
      // preceding ~2KB of source, and the brace-depth from
      // that opener up to the fetch must be POSITIVE — meaning
      // we're still inside the execute call's options object.
      // If the depth has gone to zero before the fetch, the
      // execute block has already closed and the fetch is bare.
      const fetchSites: number[] = [];
      let m: RegExpExecArray | null;
      const fetchRe = /\bfetch\s*\(/g;
      while ((m = fetchRe.exec(stripped)) !== null) {
        fetchSites.push(m.index);
      }
      const bareSites: number[] = [];

      for (const at of fetchSites) {
        const windowText = stripped.slice(Math.max(0, at - 2000), at);
        const lastOpener = windowText.lastIndexOf(
          'this.circuitBreaker.execute',
        );
        if (lastOpener === -1) {
          bareSites.push(at);
          continue;
        }
        // Walk from the opener to the fetch, counting unmatched
        // `{`. If depth > 0 at the fetch we're inside the
        // execute call (the `fn:` lambda's body). If depth ≤ 0
        // we're outside.
        const between = windowText.slice(lastOpener);
        let depth = 0;
        for (const ch of between) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
        if (depth <= 0) {
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

  // CIRCUIT-LOW-002 sibling: sensor-service AppModule
  // registers the canonical CircuitBreakerModule.
  it('sensor-service app.module.ts imports CircuitBreakerModule', () => {
    const src = read('apps/sensor-service/src/app.module.ts');
    expect(src).toMatch(
      /import\s*{[^}]*CircuitBreakerModule[^}]*}\s*from\s*['"]@aquaculture\/backend-common\/resilience['"]/,
    );
    expect(src).toMatch(/CircuitBreakerModule\s*,/);
  });
});
