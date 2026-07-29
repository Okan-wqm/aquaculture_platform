/**
 * INVARIANT: the finding registry agrees with merged history about what is
 * closed.
 *
 * ## The two records of one fact
 *
 * "Is this finding closed?" had two answers in this repository:
 *
 *   - the `Closes:` trailer on the commit that fixed it — mandatory for every
 *     fix/security/refactor commit, refused at commit time by
 *     `commit-msg-validator`, validated against this registry, and immutable
 *     once merged;
 *   - the registry entry's `state` field — transitioned by a human running
 *     `finding-registry close <id> <sha>` after the merge.
 *
 * One is enforced and complete. The other is a ceremony someone has to remember,
 * once per finding, after every merge. So the second drifted: when this gate was
 * written, 132 findings closed by commits already on `origin/main` were still
 * OPEN or IN-PROGRESS.
 *
 * ## Why that is worse than untidy
 *
 * The registry is what the dashboards, the plan-contract spec and the daily
 * `sweep` read. `sweep` moves anything OPEN for 30 days to STALE — so completed,
 * merged, verified work was on course to be relabelled abandoned, while the
 * genuinely-open findings it exists to surface sat in the same bucket as 132
 * false positives. CLAUDE.md names this failure directly: without traceability
 * `docs/reviews/` becomes audit theater. A registry that is 45% wrong about
 * closure IS the audit theater, whether or not the trailers are perfect.
 *
 * ## The rule
 *
 * State is DERIVED from merged history, not remembered alongside it. Anything
 * closed by a commit reachable from the base ref must be RESOLVED here.
 * `finding-registry reconcile` performs the derivation through the same guards
 * the close ceremony uses; this gate fails the build while any drift remains, so
 * the derivation cannot quietly stop being run.
 *
 * Branch-local commits are deliberately NOT considered: a finding closed on an
 * unmerged branch is not yet closed, which is the same rule `close` enforces by
 * refusing a SHA unreachable from `origin/main`.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

import {
  collectMergedClosures,
  planClosureReconciliation,
  loadRegistryForInspection,
} from '../../tools/gates/finding-registry';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * The merged baseline. `origin/main` in CI (checkout uses `fetch-depth: 0`);
 * a local clone may only have `main`.
 */
function resolveBaseRef(): string {
  for (const ref of ['origin/main', 'main']) {
    try {
      execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--verify', `${ref}^{commit}`], {
        stdio: 'ignore',
      });
      return ref;
    } catch {
      continue;
    }
  }
  throw new Error(
    'Neither origin/main nor main is readable in this clone. This gate certifies ' +
      'closure state against merged history and refuses to certify blind — fetch ' +
      'the base ref (CI uses fetch-depth: 0) and re-run.',
  );
}

describe('INVARIANT: finding registry closure drift', () => {
  const baseRef = resolveBaseRef();
  const entries = loadRegistryForInspection();
  const knownIds = new Set(entries.map((entry) => entry.id));
  const closures = collectMergedClosures(REPO_ROOT, baseRef, knownIds);

  it('reads a real registry and a real history (neither may be empty)', () => {
    // An empty registry or an empty closure set would make the assertion below
    // vacuously true — the failure mode a drift gate must not have.
    expect(entries.length).toBeGreaterThan(100);
    expect(closures.length).toBeGreaterThan(50);
  });

  it('marks every finding closed by a merged commit as RESOLVED', () => {
    const drift = planClosureReconciliation(entries, closures);
    const offenders = drift.map(
      (item) =>
        `${item.findingId} is ${item.currentState} but ${item.sha.slice(0, 12)} on ${baseRef} ` +
        'carries its Closes: trailer',
    );

    // Remediation when this fails: `npx tsx tools/gates/finding-registry.ts
    // reconcile` (add --dry-run first to read the plan).
    expect(offenders).toEqual([]);
  });
});
