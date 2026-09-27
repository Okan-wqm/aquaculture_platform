/**
 * There must be exactly ONE implementation that publishes ARIA's persistent
 * state to `aria/state`, and every lane that pushes the branch must use it.
 *
 * THE SIBLING RULE. `aria-single-restore-path.spec.ts` pins one materialiser,
 * because two restore transactions around one hash-chained ledger is how the
 * ledger diverges. The publish side has the same hazard and it was already
 * violated when this file was written: `aria-state-maintenance.yml` committed
 * its compaction with a shell `git add -A` / `git commit` / `git push` while
 * every other lane went through `aria_kernel state publish`.
 *
 * WHAT THE SECOND PUBLISHER COST, measured on `origin/aria/state` tip
 * 84032eda1 (2026-09-11). A whole-tree add admits everything the store's
 * writers leave on disk — sixteen zero-byte `*.lock` side-cars (`file_lock`
 * keeps them by design), `repo_identity.json`, `integrity_index.json` — and it
 * commits whatever `snapshot.json` happens to be there, which compaction had
 * just made stale. The kernel's publish stages only the surfaces its snapshot
 * attests and verifies the committed tree against that snapshot, so on top of
 * that tip it inherited the side-cars through the index, was refused by its
 * own verifier (`state_snapshot_unclaimed_tree_entry:tools/cycles.jsonl.lock`),
 * and soft-reset — every publish, from every lane, from 2026-09-04 on. One
 * publisher with a looser staging contract silently disabled the other.
 *
 * The lane now publishes through the kernel (the same verb, the same bounded
 * pathspec, a fresh snapshot, the inherited-entry healing in
 * `state_tree_contract.py`, the same verification). This file is what stops
 * a second publish path re-forming — the same tier-3 role the restore spec
 * plays, aimed at the write side.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const ACTIONS_DIR = join(REPO_ROOT, '.github', 'actions');

/**
 * The one way state reaches the branch. Matched on the verb, not on a step
 * name: renaming the step is not what this guards against.
 */
const PUBLISHES_THROUGH_THE_KERNEL = /aria_kernel state publish\b/;

/**
 * A push that targets the state branch by any spelling — `HEAD:aria/state`,
 * `HEAD:refs/heads/aria/state`, a bare `aria/state` refspec.
 */
const PUSHES_THE_STATE_BRANCH = /git\s+push\b[^\n]*\baria\/state\b/;

/**
 * A whole-tree add. Any of these commits what happens to be on disk — the
 * side-cars, the host identity, a stale snapshot — which is the exact
 * staging contract the kernel's bounded pathspec exists to forbid.
 */
const WHOLE_TREE_ADD = /git\s+add\s+(?:-A\b|--all\b|\.(?:\s|$))/;

/**
 * A lane that names the branch at all — in a push, a fetch refspec, a
 * `state publish` step, or a `state checkout` — is a lane whose file must not
 * carry a whole-tree add anywhere: the store worktree is where such an add
 * would run, and a lane that reaches the branch and adds the whole tree is
 * the retired maintenance shape by definition.
 */
const TOUCHES_THE_STATE_BRANCH = /\baria\/state\b|aria_kernel state (?:publish|checkout)\b/;

/**
 * The file with comment-only lines removed. A raw scan would FAIL on prose
 * about the rule — the maintenance lane's header now explains, in a comment,
 * that it once ran `git add -A`. Line-level rather than a YAML parse, for the
 * same reason as the restore spec: an inline `#` after a real command is part
 * of an executable line.
 */
function executableYaml(body: string): string {
  return body
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

function ciFiles(): { rel: string; body: string }[] {
  const files: { rel: string; body: string }[] = [];
  for (const name of readdirSync(WORKFLOW_DIR).filter((n) => /\.ya?ml$/.test(n))) {
    files.push({
      rel: `.github/workflows/${name}`,
      body: executableYaml(readFileSync(join(WORKFLOW_DIR, name), 'utf8')),
    });
  }
  if (existsSync(ACTIONS_DIR)) {
    for (const dir of readdirSync(ACTIONS_DIR, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const candidate of ['action.yml', 'action.yaml']) {
        const abs = join(ACTIONS_DIR, dir.name, candidate);
        if (existsSync(abs)) {
          files.push({
            rel: `.github/actions/${dir.name}/${candidate}`,
            body: executableYaml(readFileSync(abs, 'utf8')),
          });
          break;
        }
      }
    }
  }
  return files;
}

describe('ARIA state has a single publish path', () => {
  it('has no CI file pushing aria/state with git directly', () => {
    // The kernel's push lives in state_store.py, under its own AST-checked
    // invariant (`ForceIsNotReachable`). A `git push ... aria/state` in a
    // workflow is a second publisher by construction, whatever it staged.
    const offenders = ciFiles()
      .filter(({ body }) => PUSHES_THE_STATE_BRANCH.test(body))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it('has no lane that reaches aria/state staging the whole tree', () => {
    const offenders = ciFiles()
      .filter(({ body }) => TOUCHES_THE_STATE_BRANCH.test(body) && WHOLE_TREE_ADD.test(body))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it('has the maintenance lane publishing through the kernel', () => {
    // Presence of the rule is not enough: the lane could simply have lost its
    // publish step, and a compaction nobody publishes is a lane that runs
    // green and changes nothing — the ORPHAN-CRITICAL-806 shape by another
    // route.
    const lane = ciFiles().find(({ rel }) => rel.endsWith('/aria-state-maintenance.yml'));
    expect(lane).toBeDefined();
    expect(lane!.body).toMatch(PUBLISHES_THROUGH_THE_KERNEL);
    expect(lane!.body).toMatch(/aria_kernel state compact\b/);
  });

  it('has every publishing lane using that one implementation', () => {
    // Every lane that materialises the store through the restore action is a
    // lane that may write into it; each one that publishes must do so through
    // the kernel verb. A lane that restores and never publishes (the daily
    // report reads only) is fine; a lane that publishes any other way is not.
    const restoring = ciFiles().filter(({ body }) =>
      body.includes('uses: ./.github/actions/restore-aria-state'),
    );
    expect(restoring.length).toBeGreaterThan(0);
    for (const { rel, body } of restoring) {
      const publishes = PUBLISHES_THROUGH_THE_KERNEL.test(body);
      const commits = /git\s+commit\b/.test(body) || PUSHES_THE_STATE_BRANCH.test(body);
      expect({ rel, publishesThroughKernel: publishes || !commits }).toEqual({
        rel,
        publishesThroughKernel: true,
      });
    }
  });
});
