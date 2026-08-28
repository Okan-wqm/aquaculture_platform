/**
 * ORPHAN-HIGH-745 — the findings ledger may grow, never shrink.
 *
 * Measured on 2026-08-19: `ORPHAN-CRITICAL-733`'s record vanished from
 * main. Its FIX was still there (the pressure vocabulary is registered in
 * both tables), but the record of what went wrong and why was gone —
 * silently, as a side effect of a harvest that copied a file wholesale
 * from a worktree built on an older base. Nobody deleted it on purpose;
 * that is exactly the danger. An audit ledger you can lose by accident is
 * not an audit ledger.
 *
 * The rule is deliberately narrow: headings may be ADDED, and their bodies
 * may be edited (a finding's status legitimately changes from OPEN to
 * RESOLVED). What may not happen is a heading present in the base
 * disappearing from the head.
 */
import { execFileSync } from 'node:child_process';

const HEADING = /^## (ORPHAN|INFRA|DEPLOY|PROC|SEC|AUDIT|TEST|CI)-[A-Z]+-\d+/gm;

function headings(ref: string): Set<string> {
  const blob = execFileSync('git', ['show', `${ref}:docs/reviews/orphan-findings.md`], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return new Set(blob.match(HEADING) ?? []);
}

function baseRef(): string {
  // The merge-base against the default branch is what "before this work"
  // means for a branch; on main itself it degrades to the previous commit,
  // which is the same question asked of one merge.
  try {
    return execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
      encoding: 'utf-8',
    }).trim();
  } catch {
    return 'HEAD~1';
  }
}

describe('the orphan findings ledger is append-only', () => {
  it('keeps every finding heading that already existed', () => {
    const before = headings(baseRef());
    const after = headings('HEAD');
    const lost = [...before].filter((h) => !after.has(h));
    expect(lost).toEqual([]);
  });
});
