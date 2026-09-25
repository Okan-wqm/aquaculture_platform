/**
 * INVARIANT: a long CI gate's concurrency group is the COMMIT, not the branch.
 *
 * `concurrency.cancel-in-progress: true` on a branch-scoped group means a new
 * push cancels the run still going for the previous commit. For a workflow that
 * finishes in a couple of minutes that is the intended dedup. For one that
 * takes an hour it is a gate that never reaches a verdict: any branch pushing
 * more often than the suite takes cancels it every time.
 *
 * aria-kernel measures its own suite at 3539 s and budgets 110 minutes, and 17
 * consecutive runs on one PR branch completed as `cancelled` — none as success
 * or failure — while the branch carried a real change to
 * `aria_kernel/security/grant.py`. `cancelled` is not a red check, so nothing
 * blocked the merge (INFRA-HIGH-189). The same shape as FARM-MEDIUM-303: a gate
 * that is configured, never executed to completion, and invisible because its
 * non-result is not a failure.
 *
 * Keying the group on the SHA keeps the dedup the key was added for — a
 * `pull_request` event and a `push` event for ONE commit still share a group —
 * and drops the cross-commit cancellation it was never meant to cause. So the
 * test is not "don't cancel"; it is "cancel only within a commit".
 *
 * Scoped to the workflows listed below because the trade is real: a superseded
 * commit's run finishes on its own minutes. That is worth paying for a gate
 * measured in tens of minutes, and not worth paying for a two-minute linter.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Workflows whose runtime makes branch-scoped cancellation a correctness bug
 * rather than a saving. Add one here when its suite grows past ~15 minutes.
 */
const LONG_GATES: readonly string[] = ['aria-kernel.yml'];

/** The `concurrency:` block of a workflow, as raw lines. */
function concurrencyBlock(workflow: string): string {
  const file = path.join(REPO_ROOT, '.github/workflows', workflow);
  const raw = fs.readFileSync(file, 'utf8');
  const start = raw.indexOf('\nconcurrency:');
  expect(start).toBeGreaterThan(-1);
  const rest = raw.slice(start + 1);
  // Ends at the next top-level key (a line starting in column 0).
  const end = rest.search(/\n[A-Za-z_]/);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('INVARIANT: long CI gates cancel within a commit, not across commits', () => {
  it.each(LONG_GATES)('%s keys its concurrency group on the SHA', (workflow) => {
    const block = concurrencyBlock(workflow);
    const group = /^\s*group:\s*(.+)$/m.exec(block)?.[1] ?? '';
    expect(group).not.toBe('');

    // A branch reference in the key is the defect: two different commits on one
    // branch land in the same group and the older run is cancelled.
    for (const branchRef of ['github.head_ref', 'github.ref', 'github.ref_name']) {
      expect(group).not.toContain(branchRef);
    }
    // And the key must actually name a commit, or it groups everything.
    expect(group).toMatch(/github\.(sha|event\.pull_request\.head\.sha)/);
  });

  it.each(LONG_GATES)('%s still dedups a PR event against a push for one commit', (workflow) => {
    const block = concurrencyBlock(workflow);
    // Keeping cancel-in-progress is the point: within a SHA the two events
    // should still collapse to one run rather than being charged twice
    // (the saving INFRA-HIGH-001 added the key for).
    expect(/^\s*cancel-in-progress:\s*true\s*$/m.test(block)).toBe(true);
  });
});
