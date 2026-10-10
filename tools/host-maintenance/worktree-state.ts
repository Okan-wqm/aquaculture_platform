/**
 * Filesystem facts about one worktree that git's porcelain does not report:
 * when it was last used, whether a multi-step git operation is half done,
 * which ignored files are only rebuildable caches, and whether another
 * worktree's symlinks point into it. No git processes are spawned here.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function canonical(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Strictly inside: a directory is never within itself. */
export function isStrictlyWithin(child: string, parent: string): boolean {
  const prefix = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(prefix);
}

/** The worktree's private git directory, from the `.git` file git wrote into it. */
export function worktreeGitDir(worktree: string): string | null {
  try {
    const content = readFileSync(join(worktree, '.git'), 'utf8');
    const match = /^gitdir: (.+)$/m.exec(content);
    return match?.[1] ? resolve(worktree, match[1].trim()) : null;
  } catch {
    return null;
  }
}

function reflogTailMs(logPath: string): number | null {
  let fd: number | null = null;
  try {
    fd = openSync(logPath, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, 8192);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').trimEnd().split('\n');
    const last = lines[lines.length - 1] ?? '';
    const match = /> (\d+) [+-]\d{4}\t/.exec(last) ?? /> (\d+) [+-]\d{4}$/.exec(last);
    return match?.[1] ? Number(match[1]) * 1000 : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Newest of the HEAD reflog's last entry and the index mtime; null when
 * neither can be read. Two stamps instead of a walk: node_modules alone is
 * hundreds of thousands of files.
 */
export function lastActivityMs(gitDir: string): number | null {
  const stamps = [reflogTailMs(join(gitDir, 'logs', 'HEAD')), mtimeMs(join(gitDir, 'index'))];
  const known = stamps.filter((s): s is number => s !== null);
  return known.length === 0 ? null : Math.max(...known);
}

/** State files git leaves while a rebase, merge, cherry-pick, revert or bisect is unfinished. */
const OPERATION_MARKERS = [
  'rebase-merge',
  'rebase-apply',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
  'BISECT_START',
  'sequencer',
];

export function operationInProgress(gitDir: string): string | null {
  return OPERATION_MARKERS.find((marker) => existsSync(join(gitDir, marker))) ?? null;
}

/**
 * Ignored content that a later `npm ci`, build, test run or interpreter
 * recreates on its own, so deleting it loses nothing. Everything else that
 * is ignored (ARIA ledgers, review state, keys, local evidence) is somebody's
 * data that merely is not committed, and keeps the worktree.
 */
const REBUILDABLE_DIRS = new Set([
  'node_modules',
  '.nx',
  'dist',
  'out-tsc',
  'coverage',
  'target',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.turbo',
]);
const REBUILDABLE_FILE = /(\.pyc|\.tsbuildinfo|^\.eslintcache)$/;

export function isRebuildableCache(path: string): boolean {
  const segments = path.replace(/\/$/, '').split('/');
  const base = segments[segments.length - 1] ?? '';
  return segments.some((s) => REBUILDABLE_DIRS.has(s)) || REBUILDABLE_FILE.test(base);
}

/**
 * ARIA's own records in a worktree: untracked or ignored files under these
 * paths, which only that worktree holds. The user decided on 2026-10-09
 * that ARIA's structures must not be deleted ("ARIA'ya özgü yapılar
 * silinmemeli") and on 2026-10-10 that finished ARIA worktrees should be
 * ("bitmiş ARIA worktree'leri silinsin"). Resolution, 2026-10-10: preserve,
 * don't keep - these files are archived and verified (gc-archive.ts) before
 * the worktree is removed. Tracked, unmodified files here are ARIA's
 * committed code, preserved in git, and need no archive.
 */
export const ARIA_ARCHIVE_PATHS = [
  'aria-findings',
  '.aria-ci',
  'aria-tools',
  'aria-worktrees',
  '.claude/agents/.dispatch-log.jsonl',
];
/** ...and every top-level entry whose name starts with `aria-agent-outputs`. */
const ARIA_ARCHIVE_PREFIX = 'aria-agent-outputs';

export function isAriaArchivePath(path: string): boolean {
  const clean = path.replace(/\/$/, '');
  return (
    ARIA_ARCHIVE_PATHS.some((p) => clean === p || clean.startsWith(`${p}/`)) ||
    (clean.split('/')[0] ?? '').startsWith(ARIA_ARCHIVE_PREFIX)
  );
}

/**
 * A real ARIA store is never archived and removed; it keeps its worktree
 * (aria_store): a `.aria-state-store` or `state.git` at the top level or
 * anywhere under the ARIA paths, or an aria-tools/ over 50 MB (byproducts
 * are tens of kilobytes). Symlinks are not followed; a tree too big or too
 * unreadable to judge keeps it too.
 */
const ARIA_STORE_MARKERS = new Set(['state.git', '.aria-state-store']);
const ARIA_STORE_LIMIT_BYTES = 50 * 1024 * 1024;
const ARIA_STORE_MAX_ENTRIES = 100_000;

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN';
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function ariaStoreEvidence(worktree: string): string | null {
  for (const marker of ARIA_STORE_MARKERS) {
    if (lexists(join(worktree, marker))) return `${marker} at the top level`;
  }
  let tops: string[];
  try {
    tops = readdirSync(worktree).filter((e) => e.startsWith(ARIA_ARCHIVE_PREFIX));
  } catch (error) {
    return `${worktree}: ${errorCode(error)}`;
  }
  let entries = 0;
  for (const top of [...ARIA_ARCHIVE_PATHS, ...tops]) {
    const root = join(worktree, top);
    if (!lexists(root) || !lstatSync(root).isDirectory()) continue;
    const stack = [root];
    let bytes = 0;
    for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch (error) {
        return `${dir}: ${errorCode(error)}`;
      }
      for (const name of names) {
        const full = join(dir, name);
        if (ARIA_STORE_MARKERS.has(name)) return `${full.slice(worktree.length + 1)} present`;
        entries += 1;
        if (entries > ARIA_STORE_MAX_ENTRIES) {
          return `ARIA paths hold over ${ARIA_STORE_MAX_ENTRIES} entries`;
        }
        try {
          const stat = lstatSync(full);
          if (stat.isDirectory()) stack.push(full);
          else bytes += stat.size;
        } catch (error) {
          return `${full}: ${errorCode(error)}`;
        }
        if (top === 'aria-tools' && bytes > ARIA_STORE_LIMIT_BYTES) {
          return 'aria-tools exceeds 50 MB';
        }
      }
    }
  }
  return null;
}

function symlinkTarget(link: string): string | null {
  try {
    if (!lstatSync(link).isSymbolicLink()) return null;
    return canonical(link) ?? resolve(dirname(link), readlinkSync(link));
  } catch {
    return null;
  }
}

function workspaceDirs(worktree: string): string[] {
  let patterns: unknown;
  try {
    const manifest = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8')) as {
      workspaces?: unknown;
    };
    patterns = manifest.workspaces;
  } catch {
    return [];
  }
  let list: unknown = [];
  if (Array.isArray(patterns)) list = patterns;
  else if (patterns !== null && typeof patterns === 'object' && 'packages' in patterns) {
    list = patterns.packages;
  }
  if (!Array.isArray(list)) return [];
  const dirs: string[] = [];
  for (const pattern of list) {
    if (typeof pattern !== 'string') continue;
    if (!pattern.endsWith('/*')) {
      dirs.push(join(worktree, pattern));
      continue;
    }
    const parent = join(worktree, pattern.slice(0, -2));
    try {
      for (const entry of readdirSync(parent)) dirs.push(join(parent, entry));
    } catch {
      // A workspace glob whose parent does not exist in this checkout has no links.
    }
  }
  return dirs;
}

/**
 * Where the symlinks another worktree depends on point: its top-level
 * entries (the shared node_modules link the agent sessions create) and each
 * npm workspace's node_modules. A candidate any of these resolve into is
 * still in use by that other worktree, even if no process is running there.
 */
export function symlinkTargetsOf(worktree: string): string[] {
  const links: string[] = [];
  try {
    for (const entry of readdirSync(worktree)) links.push(join(worktree, entry));
  } catch {
    return [];
  }
  for (const dir of workspaceDirs(worktree)) links.push(join(dir, 'node_modules'));
  return links.map(symlinkTarget).filter((t): t is string => t !== null);
}
