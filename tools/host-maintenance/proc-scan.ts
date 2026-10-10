/**
 * Which paths do live processes hold? Read from /proc: every process's cwd,
 * every open fd, every mapped file. Used by worktree-gc.ts to keep any
 * worktree something is still using.
 *
 * Fails closed: one process that cannot be read makes the whole scan
 * unusable, because the process we could not read is exactly the one we
 * know nothing about. A process that vanished mid-scan holds nothing.
 */
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type ProcScan = { ok: true; paths: Set<string> } | { ok: false; detail: string };

const GONE = new Set(['ENOENT', 'ESRCH']);
const DELETED_SUFFIX = ' (deleted)';

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN';
}

export function scanProcessPaths(procRoot: string): ProcScan {
  let pids: string[];
  try {
    pids = readdirSync(procRoot).filter((e) => /^\d+$/.test(e));
  } catch (error) {
    return { ok: false, detail: `${procRoot}: ${errorCode(error)}` };
  }
  if (pids.length === 0) return { ok: false, detail: `${procRoot} lists no processes` };
  const paths = new Set<string>();
  for (const pid of pids) {
    const base = join(procRoot, pid);
    try {
      paths.add(readlinkSync(join(base, 'cwd')));
      for (const fd of readdirSync(join(base, 'fd'))) {
        try {
          paths.add(readlinkSync(join(base, 'fd', fd)));
        } catch (error) {
          if (!GONE.has(errorCode(error))) throw error;
        }
      }
      for (const line of readFileSync(join(base, 'maps'), 'utf8').split('\n')) {
        const slash = line.indexOf('/');
        if (slash !== -1) paths.add(line.slice(slash));
      }
    } catch (error) {
      if (GONE.has(errorCode(error))) continue;
      return { ok: false, detail: `${base}: ${errorCode(error)}` };
    }
  }
  return { ok: true, paths };
}

/** The candidates that some held path lies in (or is). */
export function heldWorktrees(scanPaths: Set<string>, candidates: string[]): Set<string> {
  const wanted = new Set(candidates);
  const held = new Set<string>();
  for (const raw of scanPaths) {
    let path = raw.endsWith(DELETED_SUFFIX) ? raw.slice(0, -DELETED_SUFFIX.length) : raw;
    while (path.length > 1) {
      if (wanted.has(path)) held.add(path);
      path = dirname(path);
    }
  }
  return held;
}
