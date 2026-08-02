/**
 * RC-6 — there must be exactly ONE implementation that restores the
 * `aria-tools-state` artifact, and both ARIA lanes must use it.
 *
 * WHY. `aria-tools/` is gitignored, so ARIA's whole accumulated state — the
 * agent-invocation queue, the hash-chained ledgers, the breaker evidence — lives
 * between runs only inside that artifact. Two lanes restore it and republish it.
 * The plan's requirement for the breaker-recovery dispatch was blunt: no second
 * restore path, because a duplicate transaction around a hash-chained ledger is
 * how the ledger diverges.
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

const RESTORE_ACTION = '.github/actions/restore-aria-tools-state';

/** The lanes that carry ARIA state across runs. */
const STATE_CARRYING_WORKFLOWS = ['aria-agent-executor.yml', 'aria-auto-cycle.yml'] as const;

/**
 * What an implementation of the restore looks like, independent of how it is
 * spelled. Matched on the artifact-download behaviour rather than on a step
 * name: renaming the step is not what this guards against — a second copy of the
 * download is.
 */
const DOWNLOADS_THE_STATE_ARTIFACT =
  /archive_download_url|actions\/artifacts\?name=aria-tools-state/;

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

describe('aria-tools-state has a single restore path (RC-6)', () => {
  it('has exactly one implementation that downloads the state artifact', () => {
    const implementations = ciFiles()
      .filter(({ body }) => DOWNLOADS_THE_STATE_ARTIFACT.test(executableYaml(body)))
      .map(({ rel }) => rel);

    expect(implementations).toEqual([`${RESTORE_ACTION}/action.yml`]);
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
