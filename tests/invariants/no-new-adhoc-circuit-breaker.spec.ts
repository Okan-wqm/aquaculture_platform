/**
 * Platform-wide invariant — CIRCUIT-MEDIUM-001:
 *
 * The 4 known ad-hoc circuit-breaker implementations (gateway
 * proxy, OPA, messaging-redis, email sender) are the GRANDFATHERED
 * set being migrated to the canonical CircuitBreakerService under
 * the W3 wave. NO NEW ad-hoc breaker class may be added until
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
import { existsSync, readFileSync } from 'node:fs';
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
    path: 'apps/gateway-api/src/proxy/circuit-breaker.service.ts',
    followOn: 'W3 wave — gateway proxy migration',
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

  it('the grandfathered list is a ceiling that only ratchets down', () => {
    // THIS ASSERTED THE DEBT MUST PERSIST. It read "all 4 grandfathered ad-hoc
    // breaker paths still exist" and failed when the W3 sweep DELETED
    // `apps/gateway-api/src/opa/opa-client.service.ts` — the progression this
    // file's own docstring calls the success condition ("eventually the list
    // goes empty and the invariant is 'no ad-hoc breaker anywhere'"). A gate
    // that goes red when debt is paid teaches its readers to leave debt alone,
    // and the cheapest way to make it green again is to restore the ad-hoc
    // breaker. That is the exact opposite of what it is for.
    //
    // Two properties now, in the right direction. A vanished path means the
    // entry is STALE and must be deleted from the list — the failure names the
    // line to remove, not a file to restore. And the ceiling can only fall:
    // adding an entry is adding a new ad-hoc breaker, which clause 3 already
    // forbids, so it must not be reachable by editing this list either.
    const stale = KNOWN_ADHOC_BREAKERS.filter(
      ({ path }) => !existsSync(resolve(REPO_ROOT, path)),
    ).map(({ path }) => path);

    expect(stale).toEqual([]);

    // Ceiling, lowered as each entry is retired. Raising it is a review event.
    // Was 5; fell to 4 when the W3 sweep removed the OPA client's breaker.
    //
    // STALENESS IS EXISTENCE, NOT A TOKEN SCAN, and that is a correction to my
    // first attempt at this: `email-sender.service.ts` carries no
    // `class …CircuitBreaker` and no `failureThreshold`, so a token heuristic
    // read it as migrated — it is not, it hand-rolls the same thing under
    // `isCircuitOpen()`. Retiring an entry on a heuristic would have lowered
    // this ceiling past live debt and locked the wrong number in.
    expect(KNOWN_ADHOC_BREAKERS.length).toBeLessThanOrEqual(4);
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
          // Grandfathered ad-hoc breakers (W3 migration targets), DERIVED from
          // the list above rather than repeated. The copy that used to live
          // here had already drifted: it still excluded
          // `apps/gateway-api/src/opa/opa-client.service.ts`, which the W3
          // sweep deleted and which the ratchet above had correctly dropped —
          // a stale exclusion is a hole, because re-introducing an ad-hoc
          // breaker at that exact path would have been waved through by the
          // gate that exists to catch it.
          ...KNOWN_ADHOC_BREAKERS.map(({ path }) => `:!${path}`),
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

  /**
   * CIRCUIT-MEDIUM-002 — service-proxy SSE path was missing the
   * breaker wrap that sibling `proxy()` had. Cure landed inside
   * the same proxySSE method. This invariant pins the wrap so a
   * future "tidy" cannot strip it without tripping the gate.
   */
  it('CIRCUIT-MEDIUM-002 — proxySSE wraps connection-establishment fetch in circuitBreaker.execute', () => {
    const src = read('apps/gateway-api/src/proxy/service-proxy.service.ts');
    // Locate the proxySSE method body.
    const methodMatch =
      /async\s+proxySSE\s*\([\s\S]*?\)\s*:\s*Promise<void>\s*{([\s\S]*?)\n {2}}/.exec(
        src,
      );
    expect(methodMatch).not.toBeNull();
    const body = methodMatch![1] ?? '';
    // Within proxySSE: an `await this.circuitBreaker.execute(`
    // call MUST appear before the `response.body?.getReader()`
    // line (the streaming entry point — once we're streaming the
    // breaker doesn't apply).
    const executeIdx = body.search(/this\.circuitBreaker\.execute\s*\(/);
    const getReaderIdx = body.search(/response\.body\?\.getReader/);
    expect(executeIdx).toBeGreaterThan(-1);
    expect(getReaderIdx).toBeGreaterThan(-1);
    expect(executeIdx).toBeLessThan(getReaderIdx);
  });
});
