/**
 * The one parser for `git worktree list --porcelain -z` in this repository.
 *
 * Two tools read the worktree list: the collector (worktree-gc.ts), which
 * deletes worktrees, and the inventory audit (worktree-audit.ts), which
 * reports on them. When each parsed the list itself they disagreed on what a
 * record was: the audit had no notion of `locked` or `prunable`, so it could
 * never tell an operator that a worktree was protected or already gone. A
 * field the collector relies on to keep something must mean the same thing
 * in the report a human reads before trusting it.
 *
 * Dependency-free ESM so it loads under `node --experimental-strip-types`
 * from either tool.
 */

export interface WorktreeRecord {
  readonly path: string;
  readonly head: string | null;
  /** The ref exactly as git prints it (`refs/heads/main`); null when detached or bare. */
  readonly branch: string | null;
  readonly bare: boolean;
  readonly detached: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

/** `-z` because a path may legally contain a newline; NUL cannot appear in one. */
export const WORKTREE_LIST_ARGS: readonly string[] = ['worktree', 'list', '--porcelain', '-z'];

interface Draft {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

/** Parses `git worktree list --porcelain -z`: NUL-terminated fields, an empty field ends a record. */
export function parseWorktreeList(raw: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: Draft | null = null;
  for (const field of raw.split('\0')) {
    if (field === '') {
      if (current) records.push(current);
      current = null;
      continue;
    }
    const space = field.indexOf(' ');
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? '' : field.slice(space + 1);
    if (key === 'worktree') {
      if (current) records.push(current);
      current = {
        path: value,
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
    } else if (current) {
      if (key === 'HEAD') current.head = value;
      else if (key === 'branch') current.branch = value;
      else if (key === 'bare') current.bare = true;
      else if (key === 'detached') current.detached = true;
      else if (key === 'locked') current.locked = true;
      else if (key === 'prunable') current.prunable = true;
    }
  }
  if (current) records.push(current);
  return records;
}

/** `refs/heads/feat/a` -> `feat/a`; null stays null. */
export function shortBranch(ref: string | null): string | null {
  return ref === null ? null : ref.replace(/^refs\/heads\//, '');
}
