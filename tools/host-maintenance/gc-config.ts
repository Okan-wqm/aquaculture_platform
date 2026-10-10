/**
 * The worktree collector's configuration and its location rules: where it
 * may act at all. Everything here is decided before any git state is read.
 */
import { isAbsolute, join, resolve } from 'node:path';

import { canonical, isStrictlyWithin } from './worktree-state.ts';

export interface GcConfig {
  repo: string;
  roots: string[];
  protectedPaths: string[];
  graceMs: number;
  /** Only an armed pass removes anything. */
  armed: boolean;
  dryRun: boolean;
  sizeBudgetMs: number;
  passBudgetMs: number;
  maxRemovals: number;
  procRoot: string;
  /** The git executable. Tests point it at a wrapper that makes one subcommand misbehave. */
  gitBin: string;
  textfilePath: string | null;
  /** Where ARIA records are archived before a worktree goes. Never pruned by the tool. */
  archiveRoot: string;
  /** The tar executable. Tests point it at a wrapper that corrupts an archive. */
  tarBin: string;
}

/** The deploy checkout and its rollback worktrees. Not configurable away. */
export const BUILTIN_PROTECTED = ['/var/lib/aqua/deploy'];
/** Canonical ARIA state trees (ARIA owner, 2026-10-09). */
const ARIA_STATE_TREES = ['/root/aria-8b', '/home/gharunner'];
export const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_TEXTFILE = '/var/lib/node_exporter/textfile/aqua_worktree_gc.prom';
export const DEFAULT_ARCHIVE_ROOT = '/var/lib/aqua/worktree-gc/archive';

/**
 * Canonical ARIA state is never collected, whatever WORKTREE_GC_ROOTS says:
 * /root/aria-8b (with its .aria-state-store), /var/lib/aria*, the runner
 * home /home/gharunner (its _work/.../.aria-state-store), and any path
 * through a `.aria-state-store` directory. Hard-coded, not configuration.
 */
export function isAriaStatePath(path: string): boolean {
  return (
    ARIA_STATE_TREES.some((tree) => path === tree || isStrictlyWithin(path, tree)) ||
    path.startsWith('/var/lib/aria') ||
    path.split('/').includes('.aria-state-store')
  );
}

/** Location rules only: no git and no filesystem reads beyond resolving the paths given. */
export function classifyLocation(
  path: string,
  canonicalPath: string | null,
  roots: string[],
  protectedPaths: string[],
): 'protected_path' | 'outside_roots' | null {
  const forms = [path, canonicalPath].filter((p): p is string => p !== null);
  if (forms.some(isAriaStatePath)) return 'protected_path';
  const isProtected = protectedPaths.some((guard) => {
    const guards = [guard, canonical(guard)].filter((g): g is string => g !== null);
    return forms.some((f) => guards.some((g) => f === g || isStrictlyWithin(f, g)));
  });
  if (isProtected) return 'protected_path';
  const target = canonicalPath ?? path;
  const canonicalRoots = roots.map((r) => canonical(r)).filter((r): r is string => r !== null);
  if (!canonicalRoots.some((root) => isStrictlyWithin(target, root))) return 'outside_roots';
  return null;
}

export class ConfigError extends Error {}

function splitPaths(value: string | undefined): string[] {
  return (value ?? '')
    .split(':')
    .map((p) => p.trim())
    .filter(Boolean);
}

function numberEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number): number {
  const value = Number(env[key] ?? String(fallback));
  if (!Number.isFinite(value) || value < min) {
    throw new ConfigError(`${key}=${env[key]} must be a number >= ${min}`);
  }
  return value;
}

export function textfilePathFrom(env: NodeJS.ProcessEnv): string | null {
  const textfile = env.WORKTREE_GC_TEXTFILE_PATH ?? DEFAULT_TEXTFILE;
  return textfile === '' ? null : textfile;
}

export function readConfig(argv: string[], env: NodeJS.ProcessEnv): GcConfig {
  for (const arg of argv) {
    if (arg !== '--dry-run') {
      throw new ConfigError(`unknown argument ${arg}; the only flag is --dry-run`);
    }
  }
  const repo = env.AQUA_REPO ?? '/var/aqua-saas';
  const roots = env.WORKTREE_GC_ROOTS
    ? splitPaths(env.WORKTREE_GC_ROOTS)
    : [join(repo, '.worktrees'), '/root/wt'];
  const extraProtected = splitPaths(env.WORKTREE_GC_EXTRA_PROTECTED);
  for (const p of [repo, ...roots, ...extraProtected]) {
    if (!isAbsolute(p)) throw new ConfigError(`path ${p} is not absolute`);
  }
  if (roots.some((r) => resolve(r) === '/')) throw new ConfigError('"/" cannot be a worktree root');
  // Below an hour the grace stops covering a paused agent turn; refuse rather than guess.
  const graceHours = numberEnv(env, 'WORKTREE_GC_GRACE_HOURS', 6, 1);
  const maxRemovals = numberEnv(env, 'WORKTREE_GC_MAX_REMOVALS', 20, 1);
  if (!Number.isInteger(maxRemovals)) {
    throw new ConfigError('WORKTREE_GC_MAX_REMOVALS must be an integer');
  }
  const armed = env.WORKTREE_GC_ARMED === '1';
  const archiveRoot = resolve(env.WORKTREE_GC_ARCHIVE_ROOT ?? DEFAULT_ARCHIVE_ROOT);
  // The archive must never be something the collector could collect, nor
  // ARIA's canonical state, nor the deploy tree.
  const archiveClash = [...roots.map((r) => resolve(r)), ...BUILTIN_PROTECTED].find(
    (p) =>
      archiveRoot === p || isStrictlyWithin(archiveRoot, p) || isStrictlyWithin(p, archiveRoot),
  );
  if (archiveClash || isAriaStatePath(archiveRoot)) {
    throw new ConfigError(
      `WORKTREE_GC_ARCHIVE_ROOT=${archiveRoot} overlaps ${archiveClash ?? 'ARIA state'}`,
    );
  }
  return {
    repo: resolve(repo),
    roots: roots.map((r) => resolve(r)),
    protectedPaths: [...BUILTIN_PROTECTED, ...extraProtected.map((p) => resolve(p))],
    graceMs: graceHours * HOUR_MS,
    armed,
    dryRun: !armed || argv.includes('--dry-run'),
    sizeBudgetMs: numberEnv(env, 'WORKTREE_GC_SIZE_BUDGET_SECONDS', 120, 0) * 1000,
    passBudgetMs: numberEnv(env, 'WORKTREE_GC_PASS_BUDGET_SECONDS', 1200, 0) * 1000,
    maxRemovals,
    procRoot: env.WORKTREE_GC_PROC_ROOT ?? '/proc',
    gitBin: env.AQUA_GIT_BIN ?? 'git',
    textfilePath: textfilePathFrom(env),
    archiveRoot,
    tarBin: env.WORKTREE_GC_TAR_BIN ?? 'tar',
  };
}
