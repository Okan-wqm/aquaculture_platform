/**
 * Platform-wide invariant — Plan 023 v3 §P-5:
 *
 * Every action invocation in `.github/workflows/*.yml` MUST be SHA-pinned.
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
 * # Coherence check shape
 *
 * Every line matching `uses: <owner>/<repo>@<ref>` MUST satisfy:
 *   1. <ref> is exactly 40 hex characters (a real commit SHA), OR
 *   2. <owner>/<repo>@<ref> appears in SHA_PIN_ALLOWLIST below (an
 *      explicit operator-approved exception, expected to be empty by
 *      default at Plan 023 sign-off).
 *
 * Path-based references (`./.github/actions/<local>`) and docker-image
 * references (`docker://...`) are exempt — they have their own pinning
 * stories.
 *
 * # Failure mode
 *
 * Any mutable tag fails this spec with a precise file:line report.
 * Authors must either re-pin via `gh api repos/<owner>/<repo>/git/refs/
 * tags/<tag> --jq '.object.sha'` (and peel annotated tags via
 * `gh api repos/<owner>/<repo>/git/tags/<sha>` — see
 * docs/aria/runbooks/sha-pin-procedure.md) or add a justified entry to
 * SHA_PIN_ALLOWLIST with operator approval.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');

// Plan 023 v3 §P-5 — explicit allowlist for operator-approved
// exceptions. Each entry must be `<owner>/<repo>@<ref>` exactly as it
// appears in `uses:` and is backed by an inline justification comment
// here. Default expectation: minimum entries, each with a documented
// reason. Future structured allowlist (operator_approval_ref +
// justification ≥ 100 chars + revisit_at ≤ 90 days +
// expected_resolution) can move to `.github/workflows/sha-pin-allowlist.yml`
// when the count grows beyond a handful.
const SHA_PIN_ALLOWLIST: ReadonlyArray<string> = [
  // dtolnay/rust-toolchain uses branches as Rust-toolchain CHANNELS
  // (nightly / stable / beta), not as version refs. Pinning to a
  // commit SHA would freeze the channel pointer and defeat the
  // action's design. The action itself only sets up a Rust toolchain
  // (no arbitrary code execution from action source); operator-
  // approved exception per Plan 023 v3 sign-off.
  // operator_approval_ref: docs/aria/reviews/2026-05-09-plan-023-implementation-review.md
  // expected_resolution: dtolnay/rust-toolchain author publishes
  //   immutable SHA-pinnable releases (tracked upstream).
  'dtolnay/rust-toolchain@nightly',
];

const SHA_RE = /^[a-f0-9]{40}$/;
const USES_RE = /^\s*(?:-\s+)?uses:\s+([^\s#]+)/;

interface Violation {
  file: string;
  line: number;
  uses: string;
  reason: string;
}

function listWorkflows(): string[] {
  const entries = readdirSync(WORKFLOWS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && (e.name.endsWith('.yml') || e.name.endsWith('.yaml')))
    .map((e) => join(WORKFLOWS_DIR, e.name));
}

function scanWorkflow(path: string): Violation[] {
  const content = readFileSync(path, 'utf-8');
  const violations: Violation[] = [];
  content.split('\n').forEach((line, idx) => {
    const m = line.match(USES_RE);
    if (!m) return;
    // ORPHAN-HIGH-507 — a capture group is `string | undefined` under
    // noUncheckedIndexedAccess, and so is a split element. Guarded rather than
    // asserted: `!` would silence the compiler while leaving a `uses:` line the
    // regex matched but did not capture to crash the whole invariant at runtime.
    const target = m[1];
    if (target === undefined) return;
    // Path-based and docker references are exempt.
    if (target.startsWith('./') || target.startsWith('docker://')) return;
    // Local repo composite-action references are exempt (no @ref).
    if (!target.includes('@')) return;
    const [name, ref] = target.split('@', 2);
    if (name === undefined || ref === undefined) return;
    if (SHA_RE.test(ref)) return; // Properly SHA-pinned.
    if (SHA_PIN_ALLOWLIST.includes(`${name}@${ref}`)) return;
    violations.push({
      file: path.replace(REPO_ROOT + '/', ''),
      line: idx + 1,
      uses: target,
      reason: SHA_RE.test(ref)
        ? 'pinned but ref length wrong'
        : 'mutable tag (must be 40-hex SHA or in SHA_PIN_ALLOWLIST)',
    });
  });
  return violations;
}

describe('aria-workflow-sha-pin (Plan 023 v3 §P-5)', () => {
  it('every workflow uses SHA-pinned actions (no mutable tags)', () => {
    const workflows = listWorkflows();
    expect(workflows.length).toBeGreaterThan(0);
    const allViolations: Violation[] = [];
    for (const wf of workflows) {
      allViolations.push(...scanWorkflow(wf));
    }
    if (allViolations.length > 0) {
      const report = allViolations
        .map((v) => `  ${v.file}:${v.line}  uses: ${v.uses}  (${v.reason})`)
        .join('\n');
      throw new Error(
        `Plan 023 §P-5 — ${allViolations.length} workflow line(s) ` +
          `use mutable tag references; pin to a commit SHA via\n` +
          `  gh api repos/<owner>/<repo>/git/refs/tags/<tag> --jq '.object.sha'\n` +
          `(peel annotated tags via gh api repos/<owner>/<repo>/git/tags/<sha>):\n${report}`,
      );
    }
  });
});
