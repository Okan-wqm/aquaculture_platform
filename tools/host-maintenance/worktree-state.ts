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
 * ARIA-specific structures are never deleted - the user's decision of
 * 2026-10-09 ("ARIA'ya özgü yapılar silinmemeli"), which replaced an
 * earlier allow-list that had treated some ARIA paths as disposable inside
 * <repo>/.worktrees. A worktree is ARIA's, and kept, when it holds content
 * under one of these paths that only it has: an untracked or ignored file
 * (worktree-gc.ts asks git), or a tracked modification (kept as dirty).
 * Tracked, unmodified files there are ARIA's committed code, preserved in
 * git, and do not keep a worktree.
 */
export const ARIA_ARTIFACT_PATHS = [
  'aria-findings',
  '.aria-ci',
  'aria-tools',
  'aria-worktrees',
  '.aria-state-store',
  'state.git',
  '.claude/agents/.dispatch-log.jsonl',
];
/** ...or a top-level entry whose name starts with `aria-agent-outputs`. */
const ARIA_ARTIFACT_PREFIX = 'aria-agent-outputs';
/** The same set as git pathspecs. */
export const ARIA_PATHSPECS = [...ARIA_ARTIFACT_PATHS, `${ARIA_ARTIFACT_PREFIX}*`];

/**
 * ...or whose name says it is ARIA's work, case-insensitively:
 * - a branch (or any ref named in HEAD) with a path segment starting with
 *   `aria` - covers `aria/...`, `x/aria-...`, `lane/aria...`, `claude/aria-...`;
 * - a worktree path with `aria` anywhere in any directory name (`*aria*`).
 * The directory rule is deliberately broad: a false keep costs disk, a false
 * removal costs ARIA's work.
 */
export function ariaName(ref: string | null, path: string): string | null {
  if (ref !== null) {
    const short = ref.replace(/^refs\/heads\//, '');
    if (short.split('/').some((segment) => /^aria/i.test(segment))) return `branch ${short}`;
  }
  const dir = path.split('/').find((segment) => /aria/i.test(segment));
  return dir ? `directory ${dir}` : null;
}

/** The ref HEAD names in a worktree's git directory (`ref: refs/heads/x`), or null when detached. */
export function headRef(gitDir: string): string | null {
  try {
    const match = /^ref: (.+)$/m.exec(readFileSync(join(gitDir, 'HEAD'), 'utf8'));
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
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
