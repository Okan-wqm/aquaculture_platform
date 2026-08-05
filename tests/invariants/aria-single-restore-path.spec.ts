/**
 * RC-6 — there must be exactly ONE implementation that restores ARIA's
 * persistent state, and both ARIA lanes must use it.
 *
 * WHY. `aria-tools/` is gitignored, so ARIA's whole accumulated state — the
 * agent-invocation queue, the hash-chained ledgers, the breaker evidence — lives
 * between runs only in whatever transport carries it. Two lanes restore it and
 * republish it. The plan's requirement for the breaker-recovery dispatch was
 * blunt: no second restore path, because a duplicate transaction around a
 * hash-chained ledger is how the ledger diverges.
 *
 * THE TRANSPORT CHANGED IN PLAN Wave 1 PR 2.6b — from the 30-day
 * `aria-tools-state` artifact to the `aria/state` branch — and this file's
 * detector moved with it. The hazard is the same either way, so the rule did
 * not change; what changed is that it now also asserts the artifact is no
 * longer authoritative, because two sources of truth for one ledger is the
 * same divergence by another route.
 *
 * THE REQUIREMENT WAS ALREADY VIOLATED WHEN IT WAS WRITTEN, and not harmlessly.
 * `aria-agent-executor.yml` and `aria-auto-cycle.yml` each carried its own copy
 * of the same ~70-line Python heredoc, and the copies had drifted:
 *
 *   - the executor's wrote `restored=true` / `bootstrap=true` to
 *     `$GITHUB_OUTPUT` — ORPHAN-CRITICAL-484's proof that the tree descends from
 *     a restored one, and ORPHAN-CRITICAL-488's split between "nothing to
 *     restore" and "restore failed";
 *   - the producer's wrote neither, and its restore step had no `id:` at all, so
 *     there was no output for a publish gate to read even in principle.
 *
 * So the 484/488 fix reached the consumer and never reached the producer — the
 * 01:00 lane that mints the queue. There, a restore that failed or was skipped
 * left a bootstrap-empty tree, which passes `integrity verify` (an empty tree is
 * trivially consistent) and was published under the canonical name with
 * `overwrite: true`. Not a missed publish: the accumulated state overwritten by
 * nothing, which is the absorbing failure 484 exists to prevent.
 *
 * Both lanes now `uses:` one composite action. This file is what stops the pair
 * re-forming — the same tier-3 role `git-hook-binding.spec.ts` plays for the
 * hook mirrors, and the same defect class RC-9 removed for the sandbox backend.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const ACTIONS_DIR = join(REPO_ROOT, '.github', 'actions');

const RESTORE_ACTION = '.github/actions/restore-aria-state';

/** The lanes that carry ARIA state across runs. */
const STATE_CARRYING_WORKFLOWS = ['aria-agent-executor.yml', 'aria-auto-cycle.yml'] as const;

/**
 * What an implementation of the restore looks like, independent of how it is
 * spelled. Matched on the behaviour rather than on a step name: renaming the
 * step is not what this guards against — a second copy of the restore is.
 *
 * RE-AIMED BY THE LANE CUTOVER (PLAN Wave 1 PR 2.6b), and re-aiming it was not
 * optional. The previous pattern matched the artifact download
 * (`archive_download_url`, `actions/artifacts?name=aria-tools-state`). After
 * the cutover NOTHING in the repository matches that, so this suite would have
 * found zero implementations and stopped guarding — a gate that silently
 * measures nothing, which is worse than one that fails. The duplicate-restore
 * hazard did not go away with the transport: two transactions around one
 * hash-chained ledger is still how a ledger diverges.
 */
const RESTORES_THE_STATE_STORE = /aria_kernel state checkout|checkout_state_store/;

/**
 * The file with comment-only lines removed.
 *
 * ORPHAN-MEDIUM-458 established this for the sandbox contract: a raw text scan
 * is satisfied — or, here, FAILED — by prose about the rule rather than by the
 * rule. This file's first run proved it again from the other direction. The
 * restore action's header explains that there is deliberately no `restored=false`
 * signal, and the assertion below forbidding that string matched the sentence
 * saying so. A gate that fails on its own documentation gets its documentation
 * deleted, which is the worst possible fix.
 *
 * Line-level rather than a YAML parse, for the same reason as the sibling: an
 * inline `#` after a real command is part of an executable line.
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
      body: readFileSync(join(WORKFLOW_DIR, name), 'utf8'),
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
            body: readFileSync(abs, 'utf8'),
          });
          break;
        }
      }
    }
  }
  return files;
}

describe('ARIA state has a single restore path (RC-6)', () => {
  it('has exactly one implementation that restores the state store', () => {
    const implementations = ciFiles()
      .filter(({ body }) => RESTORES_THE_STATE_STORE.test(executableYaml(body)))
      .map(({ rel }) => rel);

    expect(implementations).toEqual([`${RESTORE_ACTION}/action.yml`]);
  });

  it('has no lane still treating the artifact as the authoritative state', () => {
    // The cutover's actual claim. `aria-tools-state` was the canonical name the
    // restore selected, so re-publishing under it would make the artifact
    // authoritative again alongside the branch — two sources of truth for one
    // ledger, and the one that cannot enforce ancestry would win whenever it
    // was newer. Run-scoped forensic names (`quarantine-evidence-<run_id>`) are
    // fine and deliberately not matched: nothing ever restores from them.
    const offenders = ciFiles()
      .filter(({ body }) => /name:\s*aria-tools-state\b/.test(executableYaml(body)))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it('has the restore bind the root it just checked out', () => {
    // A checked-out store is NOT yet a usable tools root: the branch does not
    // carry `repo_identity.json` (it records a runner-absolute path), so
    // `ensure_tools_dir` refuses it as `ambiguous_tools_root`. The binding
    // migration used to live in the producer lane only — the executor never
    // had it, and would have died at its lease check on the first restored
    // store. Asserted HERE because this file's whole subject is that the two
    // lanes share one restore: a binding that lives in one caller is the same
    // drift by another name.
    const action = executableYaml(
      readFileSync(join(REPO_ROOT, RESTORE_ACTION, 'action.yml'), 'utf8'),
    );
    expect(action).toContain('integrity migrate-tools-bootstrap');
    // And no lane may keep its own copy: two bootstraps is two answers to
    // "which root is bound", which is what this suite exists to prevent.
    const laneCopies = STATE_CARRYING_WORKFLOWS.filter((name) =>
      executableYaml(readFileSync(join(WORKFLOW_DIR, name), 'utf8')).includes(
        'migrate-tools-bootstrap',
      ),
    );
    expect(laneCopies).toEqual([]);
  });

  it('has both state-carrying lanes using that one implementation', () => {
    // Presence of the action is not enough: a lane could keep its own copy AND
    // the action could exist unused, which is how the drift started.
    for (const name of STATE_CARRYING_WORKFLOWS) {
      const body = readFileSync(join(WORKFLOW_DIR, name), 'utf8');
      expect(body).toContain(`uses: ./${RESTORE_ACTION}`);
    }
  });

  it('has the restore expose the proof outputs both publish gates read', () => {
    // ORPHAN-CRITICAL-484 / 488. Without these the publish gate cannot tell a
    // restored tree from a bootstrap-empty one, which is the state the producer
    // lane shipped in.
    const action = executableYaml(
      readFileSync(join(REPO_ROOT, RESTORE_ACTION, 'action.yml'), 'utf8'),
    );
    for (const output of ['restored:', 'bootstrap:']) {
      expect(action).toContain(output);
    }
    // And never a negative form: absence is the signal, so `restored=false`
    // would create a second way to say "no" that a guard could get wrong.
    expect(action).not.toContain('restored=false');
    expect(action).not.toContain('bootstrap=false');
  });

  it('has every lane gate its publish on the restore proof', () => {
    // The producer lane published on integrity alone until RC-6. Asserted for
    // both lanes because "the other one has it" is exactly the assumption that
    // let the drift survive.
    for (const name of STATE_CARRYING_WORKFLOWS) {
      const body = readFileSync(join(WORKFLOW_DIR, name), 'utf8');
      const publish = body
        .split('\n')
        .find(
          (line) => line.includes('steps.integrity.outputs.state_valid ==') && line.includes('if:'),
        );
      expect(publish).toBeDefined();
      expect(publish).toContain('steps.restore_state.outputs.restored');
      expect(publish).toContain('steps.restore_state.outputs.bootstrap');
    }
  });
});
