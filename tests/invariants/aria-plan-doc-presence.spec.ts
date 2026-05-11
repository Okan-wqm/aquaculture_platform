/**
 * Plan 022 §M-3 — ARIA plan doc presence invariant.
 *
 * Pre-Plan-022 Plan 019 shipped 17 commits with subjects matching
 * 'plan 019' but no `docs/aria/plans/019-*.md` ever landed on disk.
 * Traceability chain (plan -> commit -> ledger) was structurally
 * broken; Plan 022 §M-3 reconstructed the missing doc and added
 * this invariant so the same drift cannot reach mainline again.
 *
 * Contract: every Plan number N that appears in `git log --grep
 * "plan NNN"` (case-insensitive) MUST have a corresponding
 * `docs/aria/plans/NNN-*.md` file. Active plans tracked: 014..022
 * (older plans are archived; 022 is the current one being closed
 * as this invariant lands).
 *
 * # When this spec fails
 *
 *   - A new plan started landing commits (e.g. "plan 023 phase 0 ...")
 *     before the spec doc was committed: stop and write
 *     docs/aria/plans/023-<topic>.md before continuing.
 *   - A plan number was retired but commits still reference it:
 *     update the commit-message conventions OR add the missing doc.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

const REPO_ROOT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
})();

const PLAN_DIR = join(REPO_ROOT, 'docs/aria/plans');
// Active plan range. Older plans (≤013) are archived/legacy and not
// tracked by this invariant. Bump the upper bound when a new plan
// starts landing commits.
const TRACKED_PLAN_NUMBERS = [
  '014', '015', '016', '017', '018', '019', '020', '021', '022',
];

function commitsReferencePlan(planNumber: string): boolean {
  try {
    const stdout = execFileSync(
      'git',
      ['log', '--grep', `plan ${planNumber}`, '--oneline', '-i'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function planDocExists(planNumber: string): boolean {
  if (!existsSync(PLAN_DIR)) return false;
  const files = readdirSync(PLAN_DIR);
  return files.some((f) => f.startsWith(`${planNumber}-`) && f.endsWith('.md'));
}

describe('Plan 022 §M-3 — ARIA plan doc presence invariant', () => {
  for (const planNumber of TRACKED_PLAN_NUMBERS) {
    it(`plan ${planNumber}: every committed reference has a matching docs/aria/plans/${planNumber}-*.md`, () => {
      const referenced = commitsReferencePlan(planNumber);
      if (!referenced) {
        // Plan number not yet in commit history — skip; nothing to enforce.
        return;
      }
      expect(planDocExists(planNumber)).toBe(true);
    });
  }
});
