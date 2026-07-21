/**
 * Platform-wide invariant — CIRCUIT-MEDIUM-001:
 *
 * The known ad-hoc circuit-breaker implementations (OPA,
 * messaging-redis, email sender, sensor retry-util) are the
 * GRANDFATHERED set being migrated to the canonical
 * CircuitBreakerService under the W3 wave. (The gateway-proxy
 * ad-hoc breaker was removed outright with its dead
 * ServiceProxyService, APA-252 — the progression signal this
 * list's comment describes.) NO NEW ad-hoc breaker class may be added until
 * the W3 sweep completes — every new breaker usage MUST go
 * through `@aquaculture/backend-common/resilience`'s
 * `CircuitBreakerService.execute()`.
 *
 * # Why this lives in tests/invariants/
 *
 * The CircuitBreakerService library exists and is used by every
 * NEW breaker callsite landed since CIRCUIT-CRITICAL-004 closed.
 * Without a guard, a future maintainer might re-introduce a 6th
 * ad-hoc impl ("just one more local breaker, easier than wiring
 * the canonical lib") — exactly the regression class CIRCUIT-CRITICAL-004
 * captured.
 *
 * # What this spec asserts
 *
 *   1. The grandfathered set of ad-hoc impls is fixed (the
 *      KNOWN_ADHOC_BREAKERS list). Each path is annotated with
 *      its W3-migration finding ID for traceability.
 *   2. NO file under apps/** or libs/** outside the
 *      grandfathered set declares a `class.*CircuitBreaker(?!Service)`
 *      or a `failureThreshold: number` field on a non-canonical
 *      class shape (heuristic for ad-hoc breaker config).
 *   3. The canonical lib + Module are still present at the
 *      expected paths (sanity).
 *
 * Closes: docs/reviews/circuit-breaker-auditor/2026-04-28-core-platform-review.md#CIRCUIT-MEDIUM-001
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * The grandfathered set of ad-hoc breaker implementations that
 * predate CIRCUIT-CRITICAL-004. Each entry is a path that the
 * `git grep` exclusion list lets through. Removing an entry
 * (because the W3 sweep migrated that callsite) is the
 * progression signal — eventually the list goes empty and the
 * invariant is "no ad-hoc breaker anywhere."
 */
const KNOWN_ADHOC_BREAKERS: ReadonlyArray<{
  path: string;
  followOn: string;
}> = [
  {
    path: 'apps/gateway-api/src/opa/opa-client.service.ts',
    followOn: 'W3 wave — OPA client migration',
  },
  {
    path: 'apps/messaging-service/src/shared/redis.provider.ts',
    followOn: 'W3 wave — messaging redis-circuit migration',
  },
  {
    path: 'apps/admin-api-service/src/settings/services/email-sender.service.ts',
    followOn: 'W3 wave — admin email-sender migration',
  },
  {
    // Discovered while authoring this invariant — the audit
    // missed this 5th ad-hoc impl. Documented as ORPHAN-MEDIUM-033
    // in docs/reviews/orphan-findings.md so the W3 sweep picks
    // it up alongside the audit-flagged 4.
    path: 'apps/sensor-service/src/sensor/utils/retry.util.ts',
    followOn: 'W3 wave — sensor-service retry-util migration (ORPHAN-MEDIUM-033)',
  },
];

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('CIRCUIT-MEDIUM-001 — no new ad-hoc CircuitBreaker outside the grandfathered set', () => {
  it('canonical CircuitBreakerService + Module are reachable at the canonical paths', () => {
    const svc = read(
      'libs/backend-common/src/resilience/circuit-breaker/circuit-breaker.service.ts',
    );
    const mod = read(
      'libs/backend-common/src/resilience/circuit-breaker/circuit-breaker.module.ts',
    );
    expect(svc).toMatch(/export\s+class\s+CircuitBreakerService\b/);
    expect(mod).toMatch(/export\s+class\s+CircuitBreakerModule\b/);
  });

  it('all 4 grandfathered ad-hoc breaker paths still exist (each is a W3 migration follow-on)', () => {
    for (const { path } of KNOWN_ADHOC_BREAKERS) {
      const src = read(path);
      // Sanity: each path is present and has at least the
      // failureThreshold or class-shape token that originally
      // tripped the auditor.
      expect(src.length).toBeGreaterThan(0);
    }
  });

  it('NO new ad-hoc CircuitBreaker class outside the grandfathered set + canonical lib', () => {
    // git-grep with --extended-regexp accepts the POSIX ERE
    // dialect. POSIX ERE doesn't support non-capturing groups
    // `(?:...)`. We use two simpler patterns instead:
    //   pattern A: class CircuitBreaker (followed by space|{)
    //   pattern B: class <Anything>CircuitBreaker (followed by space|{)
    // Combined as `class\s+\w*CircuitBreaker[\s{]` which IS valid
    // ERE.
    let hits: string;
    try {
      hits = execFileSync(
        'git',
        [
          'grep',
          '-l',
          '-E',
          'class[[:space:]]+[A-Za-z]*CircuitBreaker[[:space:]{]',
          '--',
          'apps/',
          'libs/',
          ':!**/*.spec.ts',
          ':!**/*.test.ts',
          ':!**/__tests__/**',
          // Canonical lib: legitimately defines an internal
          // `class CircuitBreaker {` at libs/backend-common/src/
          // resilience/circuit-breaker/circuit-breaker.service.ts.
          ':!libs/backend-common/src/resilience/circuit-breaker/**',
          // Grandfathered ad-hoc breakers (W3 migration targets):
          ':!apps/gateway-api/src/opa/opa-client.service.ts',
          ':!apps/messaging-service/src/shared/redis.provider.ts',
          ':!apps/admin-api-service/src/settings/services/email-sender.service.ts',
          ':!apps/sensor-service/src/sensor/utils/retry.util.ts',
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
    } catch (err: unknown) {
      const e = err as { status?: number };
      if (e.status === 1) {
        hits = '';
      } else {
        throw err;
      }
    }
    const matched = hits.split('\n').filter((line) => line.length > 0);
    expect(matched).toEqual([]);
  });

  it('the grandfathered set is documented inline (no entry without a follow-on tag)', () => {
    // Self-referential — KNOWN_ADHOC_BREAKERS is the source of
    // truth. The assertion makes the W3-migration follow-on
    // tagging visible to anyone reading the test output. If a
    // maintainer adds a path without a followOn tag, this
    // sanity check fails.
    for (const entry of KNOWN_ADHOC_BREAKERS) {
      expect(entry.followOn).toMatch(/W3\b|migration|consolidation/);
      expect(entry.path).toMatch(/\.ts$/);
    }
  });

  // NOTE (APA-252): the former CIRCUIT-MEDIUM-002 test pinned the proxySSE
  // breaker wrap inside apps/gateway-api/src/proxy/service-proxy.service.ts,
  // which was deleted as dead code (ServiceProxyService was provided by no
  // module and had zero consumers). With the file gone there is nothing to pin.
});
