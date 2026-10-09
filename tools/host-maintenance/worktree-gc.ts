#!/usr/bin/env node
/**
 * Git-worktree garbage collector for the droplet.
 *
 * WHY THIS EXISTS
 * ---------------
 * The droplet is both the production host and the development/agent box.
 * Every agent session that lands a PR leaves a git worktree behind, and each
 * one carries its own `npm ci` (~2 GB of node_modules). On 2026-10-09 merged
 * worktrees under <repo>/.worktrees and /root/wt had eaten enough of the root
 * filesystem that the development deploy's capacity preflight
 * (scripts/deploy/droplet-capacity.sh `capacity_failures`: >= 35 GiB free,
 * >= 20 % free, and free minus projected pulls >= reserve) refused to deploy.
 * Cleanup was a human remembering to do it; this makes it the default.
 *
 * DESIGN RULES (fail closed: when unsure, keep)
 * ---------------------------------------------
 * - A worktree is removed only if ALL hold: it lives strictly under an
 *   allow-listed root, it is not locked, not the main checkout, not under the
 *   deploy state tree, it contains no other worktree, its HEAD is an ancestor
 *   of a freshly fetched origin/main, `git status` reports nothing (ignored
 *   files such as node_modules do not count), no process has its cwd, an open
 *   fd or a mapped file inside it, and nothing touched its HEAD reflog or its
 *   index for the grace period.
 * - Every check that cannot be answered keeps the worktree. A failed fetch
 *   removes nothing at all: "merged" is only meaningful against a current
 *   origin/main.
 * - Removal is `git worktree remove` WITHOUT --force, so git itself refuses
 *   anything that became dirty between the check and the removal.
 * - Branches are never deleted, local or remote. A removed worktree's branch
 *   is still there to check out again.
 * - Activity is read from two cheap stamps (reflog tail + index mtime); the
 *   tool never walks node_modules to find a newest file. `git status` runs
 *   with optional locks off, so this tool's own status call can never refresh
 *   the index and make a worktree look active forever.
 *
 * OUTPUT
 * ------
 * One single-line JSON summary on stdout (journald). Exit 0 when the pass
 * completed, 3 when some removal or the prune failed (a result, not a crash;
 * the unit lists it in SuccessExitStatus), 1 when the pass could not run at
 * all (not a repository, fetch failed, bad configuration) - nothing is
 * removed in that case.
 */
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  WORKTREE_LIST_ARGS,
  parseWorktreeList,
  shortBranch,
  type WorktreeRecord,
} from './worktree-list.ts';

export type Reason =
  | 'main_checkout'
  | 'protected_path'
  | 'outside_roots'
  | 'locked'
  | 'missing'
  | 'contains_worktree'
  | 'unmerged'
  | 'merge_check_failed'
  | 'recently_active'
  | 'activity_unknown'
  | 'merged_but_dirty'
  | 'status_failed'
  | 'process_held'
  | 'proc_unreadable'
  | 'eligible';

export type Decision = 'kept' | 'would_remove' | 'removed' | 'remove_failed';

export interface WorktreeReport {
  path: string;
  branch: string | null;
  head: string | null;
  decision: Decision;
  reason: Reason;
  detail?: string;
  bytes?: number | null;
}

export interface GcConfig {
  repo: string;
  roots: string[];
  protectedPaths: string[];
  graceMs: number;
  dryRun: boolean;
  sizeBudgetMs: number;
  procRoot: string;
  /** The git executable. Tests point it at a wrapper that makes one subcommand fail. */
  gitBin: string;
}

/** The deploy checkout and its rollback worktrees. Not configurable away. */
export const BUILTIN_PROTECTED = ['/var/lib/aqua/deploy'];
const BASE_REF = 'refs/remotes/origin/main';
const GIT_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 300_000;
const HOUR_MS = 60 * 60 * 1000;
/** Variables a git hook or a parent git process may export; any of them would redirect our git calls. */
const GIT_ENV_BLOCKLIST = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_NAMESPACE',
];

class ConfigError extends Error {}

function splitPaths(value: string | undefined): string[] {
  return (value ?? '')
    .split(':')
    .map((p) => p.trim())
    .filter(Boolean);
}

export function readConfig(argv: string[], env: NodeJS.ProcessEnv): GcConfig {
  for (const arg of argv) {
    if (arg !== '--dry-run')
      throw new ConfigError(`unknown argument ${arg}; the only flag is --dry-run`);
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
  const graceHours = Number(env.WORKTREE_GC_GRACE_HOURS ?? '6');
  // Below an hour the grace stops covering a paused agent turn; refuse rather than guess.
  if (!Number.isFinite(graceHours) || graceHours < 1) {
    throw new ConfigError(
      `WORKTREE_GC_GRACE_HOURS=${env.WORKTREE_GC_GRACE_HOURS} must be a number >= 1`,
    );
  }
  const budgetSeconds = Number(env.WORKTREE_GC_SIZE_BUDGET_SECONDS ?? '120');
  if (!Number.isFinite(budgetSeconds) || budgetSeconds < 0) {
    throw new ConfigError(
      `WORKTREE_GC_SIZE_BUDGET_SECONDS=${env.WORKTREE_GC_SIZE_BUDGET_SECONDS} must be >= 0`,
    );
  }
  const dryEnv = (env.WORKTREE_GC_DRY_RUN ?? '').toLowerCase();
  return {
    repo: resolve(repo),
    roots: roots.map((r) => resolve(r)),
    protectedPaths: [...BUILTIN_PROTECTED, ...extraProtected.map((p) => resolve(p))],
    graceMs: graceHours * HOUR_MS,
    dryRun: argv.includes('--dry-run') || dryEnv === '1' || dryEnv === 'true',
    sizeBudgetMs: budgetSeconds * 1000,
    procRoot: env.WORKTREE_GC_PROC_ROOT ?? '/proc',
    gitBin: env.AQUA_GIT_BIN ?? 'git',
  };
}

interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

function gitEnv(): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(([key]) => !GIT_ENV_BLOCKLIST.includes(key));
  return { ...Object.fromEntries(inherited), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}

function git(bin: string, args: string[], timeout: number = GIT_TIMEOUT_MS): GitResult {
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout,
    env: gitEnv(),
    maxBuffer: 64 * 1024 * 1024,
  });
  const stderr = `${r.stderr ?? ''}${r.error ? ` ${r.error.message}` : ''}`.trim();
  return { ok: r.status === 0 && !r.error, code: r.status, stdout: r.stdout ?? '', stderr };
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.slice(0, 300) ?? '';
}

/** Strictly inside: a root itself is never a removable worktree. */
export function isStrictlyWithin(child: string, parent: string): boolean {
  const prefix = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(prefix);
}

function canonical(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Location rules only: no git and no filesystem reads beyond the paths given. */
export function classifyLocation(
  path: string,
  canonicalPath: string | null,
  roots: string[],
  protectedPaths: string[],
): Reason | null {
  const forms = [path, canonicalPath].filter((p): p is string => p !== null);
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

function worktreeGitDir(worktree: string): string | null {
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

/** Newest of the HEAD reflog's last entry and the index mtime; null when neither can be read. */
export function lastActivityMs(worktree: string): number | null {
  const gitDir = worktreeGitDir(worktree);
  if (!gitDir) return null;
  const stamps = [
    reflogTailMs(join(gitDir, 'logs', 'HEAD')),
    mtimeMs(join(gitDir, 'index')),
  ].filter((s): s is number => s !== null);
  return stamps.length === 0 ? null : Math.max(...stamps);
}

export type ProcScan = { ok: true; paths: Set<string> } | { ok: false; detail: string };

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN';
}

/** A process that vanished mid-scan holds nothing; any other read failure is not knowing. */
const GONE = new Set(['ENOENT', 'ESRCH']);

/**
 * Every absolute path some process has as cwd, open fd, or mapped file.
 * Fails closed: one unreadable process makes the whole scan unusable,
 * because the process we could not read is exactly the one we know nothing about.
 */
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

/** Candidate worktrees that some scanned path lies in (or is). */
export function heldWorktrees(scanPaths: Set<string>, candidates: string[]): Set<string> {
  const wanted = new Set(candidates);
  const held = new Set<string>();
  for (const raw of scanPaths) {
    let path = raw.endsWith(' (deleted)') ? raw.slice(0, -' (deleted)'.length) : raw;
    while (path.length > 1) {
      if (wanted.has(path)) held.add(path);
      path = dirname(path);
    }
  }
  return held;
}

function measureBytes(path: string, budgetMs: number): number | null {
  if (budgetMs <= 0) return null;
  const r = spawnSync('du', ['-s', '-x', '-B1', '--', path], {
    encoding: 'utf8',
    timeout: budgetMs,
  });
  if (r.status !== 0 || r.error) return null;
  const bytes = Number(r.stdout.split('\t')[0]);
  return Number.isFinite(bytes) ? bytes : null;
}

interface Summary {
  schema: 'aqua/worktree-gc/v1';
  checked_at: string;
  repo: string;
  dry_run: boolean;
  roots: string[];
  grace_hours: number;
  base: string | null;
  fatal: { kind: string; detail: string } | null;
  prune: 'ok' | 'failed' | 'skipped_dry_run' | 'skipped_prunable_outside_roots' | 'not_run';
  counts: Record<string, number>;
  bytes_reclaimed_estimate: number | null;
  worktrees: WorktreeReport[];
}

function emptySummary(config: GcConfig, now: number): Summary {
  return {
    schema: 'aqua/worktree-gc/v1',
    checked_at: new Date(now).toISOString(),
    repo: config.repo,
    dry_run: config.dryRun,
    roots: config.roots,
    grace_hours: config.graceMs / HOUR_MS,
    base: null,
    fatal: null,
    prune: 'not_run',
    counts: {},
    bytes_reclaimed_estimate: null,
    worktrees: [],
  };
}

function fatal(
  summary: Summary,
  kind: string,
  detail: string,
): { summary: Summary; exitCode: number } {
  summary.fatal = { kind, detail };
  return { summary, exitCode: 1 };
}

/** Decides one worktree up to (not including) the process check. */
function classify(
  record: WorktreeRecord,
  all: WorktreeRecord[],
  config: GcConfig,
  base: string,
  now: number,
): { reason: Reason; detail?: string } {
  const real = canonical(record.path);
  const location = classifyLocation(record.path, real, config.roots, config.protectedPaths);
  if (location) return { reason: location };
  if (record.locked) return { reason: 'locked' };
  if (record.prunable || real === null) return { reason: 'missing' };
  const nested = all.find(
    (other) => other !== record && isStrictlyWithin(canonical(other.path) ?? other.path, real),
  );
  if (nested) return { reason: 'contains_worktree', detail: nested.path };
  if (!record.head) return { reason: 'merge_check_failed', detail: 'no HEAD recorded' };
  const ancestor = git(config.gitBin, [
    '-C',
    config.repo,
    'merge-base',
    '--is-ancestor',
    record.head,
    base,
  ]);
  if (ancestor.code === 1) return { reason: 'unmerged' };
  if (!ancestor.ok) return { reason: 'merge_check_failed', detail: firstLine(ancestor.stderr) };
  const activity = lastActivityMs(real);
  if (activity === null) return { reason: 'activity_unknown' };
  if (now - activity < config.graceMs) {
    return {
      reason: 'recently_active',
      detail: `last activity ${new Date(activity).toISOString()}`,
    };
  }
  const status = git(config.gitBin, [
    '-C',
    real,
    '--no-optional-locks',
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);
  if (!status.ok) return { reason: 'status_failed', detail: firstLine(status.stderr) };
  const changes = status.stdout.split('\n').filter(Boolean).length;
  if (changes > 0)
    return { reason: 'merged_but_dirty', detail: `${changes} uncommitted or untracked path(s)` };
  return { reason: 'eligible' };
}

export function run(
  config: GcConfig,
  now: number = Date.now(),
): { summary: Summary; exitCode: number } {
  const summary = emptySummary(config, now);
  const probe = git(config.gitBin, ['-C', config.repo, 'rev-parse', '--git-common-dir']);
  if (!probe.ok) return fatal(summary, 'not_a_repo', firstLine(probe.stderr));

  // "Merged" means merged into the origin/main that exists now. A stale
  // tracking ref would understate merges, never overstate them, but a fetch
  // failure also means we cannot see the host's view of the world clearly.
  const fetch = git(
    config.gitBin,
    ['-C', config.repo, 'fetch', '--quiet', 'origin', '--prune'],
    FETCH_TIMEOUT_MS,
  );
  if (!fetch.ok) return fatal(summary, 'fetch_failed', firstLine(fetch.stderr));
  const baseRes = git(config.gitBin, [
    '-C',
    config.repo,
    'rev-parse',
    '--verify',
    `${BASE_REF}^{commit}`,
  ]);
  if (!baseRes.ok) return fatal(summary, 'no_base', firstLine(baseRes.stderr));
  const base = baseRes.stdout.trim();
  summary.base = base;

  const list = git(config.gitBin, ['-C', config.repo, ...WORKTREE_LIST_ARGS]);
  if (!list.ok) return fatal(summary, 'worktree_list_failed', firstLine(list.stderr));
  const records = parseWorktreeList(list.stdout);
  const mainReal = canonical(config.repo) ?? config.repo;

  const reports: WorktreeReport[] = records.map((record, index) => {
    const report = {
      path: record.path,
      branch: shortBranch(record.branch),
      head: record.head?.slice(0, 12) ?? null,
    };
    // git lists the main checkout (or the bare repository) first, always.
    if (index === 0 || record.bare || canonical(record.path) === mainReal) {
      return { ...report, decision: 'kept', reason: 'main_checkout' };
    }
    const verdict = classify(record, records, config, base, now);
    return { ...report, decision: 'kept', ...verdict };
  });

  const eligible = reports.filter((r) => r.reason === 'eligible');
  let budget = config.sizeBudgetMs;
  for (const report of eligible) {
    const started = Date.now();
    report.bytes = measureBytes(report.path, budget);
    budget -= Date.now() - started;
  }

  // Scanned last, immediately before removal, so the window in which an
  // agent can start using a worktree we already judged idle is as short as
  // possible. `git worktree remove` without --force covers the rest.
  if (eligible.length > 0) {
    const scan = scanProcessPaths(config.procRoot);
    const held = scan.ok
      ? heldWorktrees(
          scan.paths,
          eligible.map((r) => canonical(r.path) ?? r.path),
        )
      : new Set<string>();
    for (const report of eligible) {
      if (!scan.ok) {
        report.reason = 'proc_unreadable';
        report.detail = scan.detail;
      } else if (held.has(canonical(report.path) ?? report.path)) {
        report.reason = 'process_held';
      }
    }
  }

  let failures = 0;
  for (const report of reports.filter((r) => r.reason === 'eligible')) {
    if (config.dryRun) {
      report.decision = 'would_remove';
      continue;
    }
    const removal = git(config.gitBin, ['-C', config.repo, 'worktree', 'remove', report.path]);
    if (removal.ok) {
      report.decision = 'removed';
    } else {
      report.decision = 'remove_failed';
      report.detail = firstLine(removal.stderr);
      failures += 1;
    }
  }

  if (config.dryRun) {
    summary.prune = 'skipped_dry_run';
  } else if (
    records.some(
      (r, i) =>
        i > 0 &&
        r.prunable &&
        classifyLocation(r.path, null, config.roots, config.protectedPaths) !== null,
    )
  ) {
    // A worktree outside our roots that git cannot see may be on a mount
    // this process cannot see (a namespace, an unmounted volume). Prune would
    // destroy its record; that is not this tool's call to make.
    summary.prune = 'skipped_prunable_outside_roots';
  } else {
    const prune = git(config.gitBin, ['-C', config.repo, 'worktree', 'prune']);
    summary.prune = prune.ok ? 'ok' : 'failed';
    if (!prune.ok) failures += 1;
  }

  const reclaimed = reports.filter(
    (r) => r.decision === 'removed' || r.decision === 'would_remove',
  );
  summary.bytes_reclaimed_estimate = reclaimed.some(
    (r) => r.bytes === null || r.bytes === undefined,
  )
    ? null
    : reclaimed.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
  const counts: Record<string, number> = { total: reports.length };
  for (const r of reports) {
    const key = r.decision === 'kept' ? `kept_${r.reason}` : r.decision;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  summary.counts = counts;
  summary.worktrees = reports;
  return { summary, exitCode: failures > 0 ? 3 : 0 };
}

function main(): number {
  let config: GcConfig;
  try {
    config = readConfig(process.argv.slice(2), process.env);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `${JSON.stringify({ schema: 'aqua/worktree-gc/v1', fatal: { kind: 'bad_config', detail } })}\n`,
    );
    return 1;
  }
  const { summary, exitCode } = run(config);
  // Single line: journald turns a pretty-printed object into N unrelated entries.
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main();
}
