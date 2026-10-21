/**
 * Platform-wide invariant — Plan 023 v3 §P-5:
 *
 * Every action invocation in `.github/workflows/*.yml` AND in the repo's own
 * composite actions (`.github/actions/<name>/action.yml`) MUST be SHA-pinned.
 * Mutable tag references (`actions/checkout@v4`, `actions/setup-python@v5`,
 * etc.) are a supply-chain class vulnerability — the tag pointer can be
 * silently moved by the action publisher (or compromised) and a workflow
 * that pinned to the tag inherits the change without any commit-level
 * audit trail.
 *
 * # Why this lives in tests/invariants/
 *
 * Pre-Plan-023 a 2026-04 audit pinned production workflows to commit
 * SHAs but ARIA workflows (aria-*.yml) and fuzz-st-parser-nightly.yml
 * were carved out. Plan 023 §P-5 closed the carve-out and added this
 * invariant so a future workflow author cannot reintroduce a mutable
 * tag without the gate flagging it at PR time.
 *
 * # Coherence check shape (ARIA-MEDIUM-590)
 *
 * The rule has ONE owner, `tools/gates/gha-sha-pin.ts`: this spec walks the
 * gate's own file set (`collectYamlFiles`) and asks the gate's verdict
 * (`inspectUsesText`) for every file. It once kept a private copy that
 * exempted `docker://` references and refs with no `@`, and allowed
 * `dtolnay/rust-toolchain@nightly`, while the gate refused all three; one
 * rule now gives one verdict:
 *
 *   - a remote action pins a 40-hex commit SHA (a channel action takes the
 *     channel as an input on a SHA-pinned ref, as fuzz-st-parser-nightly.yml
 *     does; there is no branch-ref exception),
 *   - a `docker://` image pins a sha256 digest,
 *   - a remote `uses:` with no `@ref` is refused (it runs the default branch),
 *   - a local action (`./`, `../`) is exempt.
 *
 * # Why composite actions are in scope (INFRA-MEDIUM-160)
 *
 * A composite action runs third-party action code in exactly the same trust
 * position as a workflow step, but `.github/actions/**` was outside this scan
 * — and outside Dependabot's `github-actions` scope, which `directory: /`
 * limits to `.github/workflows/**`. Nothing watched those files: while every
 * workflow was carried to `actions/setup-node` v7.0.0, the `setup-node-env`
 * composite sat on v4.2.0. Dependabot now globs `/.github/actions/*` so the
 * bumps arrive automatically; this scan is the gate that fails if one is ever
 * replaced by a mutable tag.
 *
 * # Failure mode
 *
 * Any mutable reference fails this spec with a precise file:line report.
 * Authors re-pin via `gh api repos/<owner>/<repo>/git/refs/
 * tags/<tag> --jq '.object.sha'` (and peel annotated tags via
 * `gh api repos/<owner>/<repo>/git/tags/<sha>` — see
 * docs/aria/runbooks/sha-pin-procedure.md).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  collectYamlFiles,
  inspectUsesText,
  isActionPinScopedPath,
  type PinViolation,
} from '../../tools/gates/gha-sha-pin';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** The gate's file set, split by kind, as repository-relative paths. */
function scopedFiles(kind: 'workflows' | 'actions'): string[] {
  return collectYamlFiles()
    .map((path) => path.replace(REPO_ROOT + '/', ''))
    .filter((rel) => isActionPinScopedPath(rel) && rel.startsWith(`.github/${kind}/`));
}

function violationsIn(files: readonly string[]): PinViolation[] {
  return files.flatMap((rel) =>
    inspectUsesText(rel, readFileSync(resolve(REPO_ROOT, rel), 'utf8')),
  );
}

function report(violations: readonly PinViolation[]): string {
  return violations.map((v) => `  ${v.file}:${v.line}  uses: ${v.uses}  (${v.reason})`).join('\n');
}

describe('aria-workflow-sha-pin (Plan 023 v3 §P-5)', () => {
  it('every workflow uses SHA-pinned actions (no mutable tags)', () => {
    const workflows = scopedFiles('workflows');
    expect(workflows.length).toBeGreaterThan(0);
    const allViolations = violationsIn(workflows);
    if (allViolations.length > 0) {
      throw new Error(
        `Plan 023 §P-5 — ${allViolations.length} workflow line(s) ` +
          `use mutable references; pin to a commit SHA via\n` +
          `  gh api repos/<owner>/<repo>/git/refs/tags/<tag> --jq '.object.sha'\n` +
          `(peel annotated tags via gh api repos/<owner>/<repo>/git/tags/<sha>):\n${report(allViolations)}`,
      );
    }
  });

  it('every composite action the repo owns uses SHA-pinned actions', () => {
    // INFRA-MEDIUM-160: same rule, the directory the workflow scan never read.
    const actions = scopedFiles('actions');
    expect(actions.length).toBeGreaterThan(0);
    const allViolations = violationsIn(actions);
    if (allViolations.length > 0) {
      throw new Error(
        `${allViolations.length} composite-action line(s) use mutable ` +
          `references. A composite action runs third-party code in the same ` +
          `trust position as a workflow step:\n${report(allViolations)}`,
      );
    }
  });
});
