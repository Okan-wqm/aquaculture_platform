/**
 * Invariant (farm cache SSoT): every `@Cacheable({ prefix })` in farm-service has
 * at least one `@CacheEvict({ prefixes: [...] })` that names the same prefix.
 *
 * SSOT-H-18 root cause: `batchPerformance` (`batch:performance`) and `growthAnalysis`
 * (`growth:analysis`) were cached with a multi-hour TTL but NO resolver ever evicted
 * them — a stat-mutating write (mortality, cull, growth sample) left the cached
 * FCR/survival/growth analysis stale for up to an hour. The `@CacheEvict` decorator +
 * `CacheEvictInterceptor` were fully built and registered but used NOWHERE
 * (built-but-unwired). A read-through cache that is never invalidated is a latent
 * correctness bug; this guard makes that state impossible to reintroduce silently.
 *
 * A future `@Cacheable` whose data can change therefore MUST be paired with a
 * `@CacheEvict` on the mutation(s) that change it. (If a cache is genuinely
 * immutable-for-its-TTL, it should use a `system:`/`global:` prefix and be added to
 * the EXEMPT set below with a one-line justification — there are none today.)
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FARM_SRC = 'apps/farm-service/src/';

// Prefixes that are legitimately written-once-per-TTL (no mutation invalidates them).
// Empty today; add `'<prefix>' /* why */` here only with a real justification.
const EXEMPT_PREFIXES = new Set<string>([]);

function grepFarm(fixedNeedle: string): string[] {
  try {
    return execFileSync(
      'git',
      ['-C', REPO_ROOT, 'grep', '-nF', fixedNeedle, '--', FARM_SRC],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
      .filter((l) => !/\.(spec|test)\.[tj]sx?:/.test(l) && !/__tests__/.test(l));
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 1) return []; // git grep: no matches
    throw err;
  }
}

describe("INVARIANT (farm cache SSoT): every @Cacheable prefix has a @CacheEvict", () => {
  it('no farm-service @Cacheable prefix is left without an eviction trigger', () => {
    const cacheablePrefixes = new Set<string>();
    for (const line of grepFarm('@Cacheable({')) {
      const m = line.match(/prefix:\s*'([^']+)'/);
      if (m?.[1]) cacheablePrefixes.add(m[1]);
    }

    const evictedPrefixes = new Set<string>();
    for (const line of grepFarm('@CacheEvict({')) {
      // pull every quoted token out of the `prefixes: [ '...' , '...' ]` array
      for (const m of line.matchAll(/'([^']+)'/g)) {
        if (m[1]) evictedPrefixes.add(m[1]);
      }
    }

    // Sanity: the guard must actually be observing decorators (not a silent zero scan).
    expect(cacheablePrefixes.size).toBeGreaterThan(0);

    const uncovered = [...cacheablePrefixes]
      .filter((p) => !EXEMPT_PREFIXES.has(p))
      .filter((p) => !evictedPrefixes.has(p))
      .sort();

    expect(uncovered).toEqual([]);
  });
});
