/**
 * The quarantine: <root>/.gc-quarantine/<time>-<name>. The collector moves a
 * worktree there immediately before `git worktree remove`, so a removal that
 * is killed or times out leaves a tree that is visibly the collector's own
 * work, never mistaken for somebody's half-edited checkout. Only the
 * collector writes here.
 *
 * A tree git still records and that still has its `.git` file is judged by
 * the caller (worktree-gc.ts) before it is finished. A tree whose `.git` file
 * is gone - git deleted it before the removal was killed - can only be
 * cleared by hand: `git worktree remove` no longer knows it, and a global
 * `git worktree prune` is not safe on this host. That is what this module
 * does, without following a symlink and without leaving the quarantine.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { firstLine, git } from './gc-git.ts';
import { canonical, isStrictlyWithin } from './worktree-state.ts';

export const QUARANTINE_DIR = '.gc-quarantine';

export function quarantineDirs(roots: string[]): string[] {
  return roots
    .map((r) => canonical(r))
    .filter((r): r is string => r !== null)
    .map((r) => join(r, QUARANTINE_DIR));
}

/** The quarantine directory `path` lies in, if any (by its recorded or its real path). */
export function quarantineOf(path: string, roots: string[]): string | null {
  const forms = [path, canonical(path)].filter((p): p is string => p !== null);
  return quarantineDirs(roots).find((q) => forms.some((f) => isStrictlyWithin(f, q))) ?? null;
}

/** Where a candidate under one of the roots is moved before removal. */
export function quarantineTarget(real: string, roots: string[], now: number): string | null {
  const dir = quarantineDirs(roots).find((q) => isStrictlyWithin(real, dirname(q)));
  if (!dir) return null;
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return join(dir, `${stamp}-${basename(real)}`);
}

/** True when the tree has lost the `.git` file git uses to find it. */
export function isStranded(path: string): boolean {
  return !existsSync(join(path, '.git'));
}

/** git's private record of a linked worktree: <common-dir>/worktrees/<id>, found by its gitdir file. */
function adminDirFor(repo: string, gitBin: string, recordedPath: string): string | null {
  const common = git(gitBin, ['-C', repo, 'rev-parse', '--git-common-dir']);
  if (!common.ok) return null;
  const worktrees = join(resolve(repo, common.stdout.trim()), 'worktrees');
  let ids: string[] = [];
  try {
    ids = readdirSync(worktrees);
  } catch {
    return null;
  }
  const wanted = join(recordedPath, '.git');
  for (const id of ids) {
    try {
      if (readFileSync(join(worktrees, id, 'gitdir'), 'utf8').trim() === wanted) {
        return join(worktrees, id);
      }
    } catch {
      // An admin dir without a readable gitdir file belongs to nobody we can name.
    }
  }
  return null;
}

/**
 * Deletes a stranded tree inside the quarantine and git's record of it.
 * Returns null on success, or why nothing (or not everything) was deleted.
 */
export function clearStranded(
  recordedPath: string | null,
  dir: string,
  quarantine: string,
  repo: string,
  gitBin: string,
): string | null {
  const real = canonical(dir);
  if (real !== null) {
    // The real path, not the name: a symlink planted in the quarantine must
    // not turn this into a delete somewhere else.
    if (!isStrictlyWithin(real, canonical(quarantine) ?? quarantine)) {
      return `${dir} resolves outside the quarantine (${real})`;
    }
    if (!isStranded(real)) return `${dir} has a .git file again`;
    try {
      // rmSync does not follow symlinks inside the tree; it unlinks them.
      rmSync(real, { recursive: true, force: true });
    } catch (error) {
      return `rm failed: ${firstLine(error instanceof Error ? error.message : String(error))}`;
    }
  }
  if (recordedPath === null) return null;
  const admin = adminDirFor(repo, gitBin, recordedPath);
  if (admin === null) return null;
  try {
    rmSync(admin, { recursive: true, force: true });
  } catch (error) {
    return `admin dir ${admin}: ${firstLine(error instanceof Error ? error.message : String(error))}`;
  }
  return null;
}
