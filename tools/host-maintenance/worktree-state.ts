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

/**
 * ARIA byproducts. Decision of the ARIA owner, 2026-10-09: inside
 * <repo>/.worktrees/* the gitignored `aria-findings/`, `.aria-ci/` and
 * `aria-tools/**` are written by local kernel, hook and test runs and are
 * never canonical; canonical ARIA state lives in aria/state, /root/aria-8b,
 * /var/lib/aria* and the runner's .aria-state-store. Anywhere else these
 * paths stay ignored content that keeps the worktree, and even inside
 * .worktrees an aria-tools/ that looks like a real store keeps it
 * (ariaStoreEvidence).
 */
const ARIA_BYPRODUCT_TOPS = new Set(['aria-findings', '.aria-ci', 'aria-tools']);

export function isRebuildableCache(path: string, ariaByproducts = false): boolean {
  const segments = path.replace(/\/$/, '').split('/');
  const base = segments[segments.length - 1] ?? '';
  if (ariaByproducts && ARIA_BYPRODUCT_TOPS.has(segments[0] ?? '')) return true;
  return segments.some((s) => REBUILDABLE_DIRS.has(s)) || REBUILDABLE_FILE.test(base);
}

const ARIA_STORE_MARKERS = new Set(['state.git', '.aria-state-store']);
const ARIA_STORE_LIMIT_BYTES = 50 * 1024 * 1024;
const ARIA_STORE_MAX_ENTRIES = 100_000;

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN';
}

/**
 * Why this worktree looks like it was used as a real ARIA store, or null.
 * A top-level `.aria-state-store`, a `state.git` or `.aria-state-store`
 * anywhere under aria-tools/, or an aria-tools/ over 50 MB (byproducts are
 * tens of kilobytes) all keep it. Symlinks are not followed; a tree too big
 * or too unreadable to judge keeps it too.
 */
export function ariaStoreEvidence(worktree: string): string | null {
  if (existsSync(join(worktree, '.aria-state-store'))) return '.aria-state-store at the top level';
  const root = join(worktree, 'aria-tools');
  const stack = [root];
  let bytes = 0;
  let entries = 0;
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      if (dir === root && errorCode(error) === 'ENOENT') return null;
      return `${dir}: ${errorCode(error)}`;
    }
    for (const name of names) {
      const full = join(dir, name);
      if (ARIA_STORE_MARKERS.has(name)) return `${full.slice(worktree.length + 1)} present`;
      entries += 1;
      if (entries > ARIA_STORE_MAX_ENTRIES)
        return `aria-tools has over ${ARIA_STORE_MAX_ENTRIES} entries`;
      try {
        const stat = lstatSync(full);
        if (stat.isDirectory()) stack.push(full);
        else bytes += stat.size;
      } catch (error) {
        return `${full}: ${errorCode(error)}`;
      }
      if (bytes > ARIA_STORE_LIMIT_BYTES) return 'aria-tools exceeds 50 MB';
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
