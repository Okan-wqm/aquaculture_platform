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
 * - Nothing is removed unless the host armed it (WORKTREE_GC_ARMED=1). An
 *   unarmed pass, and any pass with --dry-run, reports the same decisions
 *   and changes nothing.
 * - A worktree is removed only if ALL hold: strictly under an allow-listed
 *   root; not locked, not the main checkout, not under the deploy state tree;
 *   contains no other worktree; HEAD is an ancestor of a freshly fetched
 *   origin/main; idle for the grace period (HEAD reflog tail + index mtime);
 *   no rebase/merge/cherry-pick/revert/bisect half done; no per-worktree refs;
 *   `git status` shows nothing tracked or untracked and every ignored path is
 *   a rebuildable cache; its HEAD reflog reaches no commit that only the
 *   reflog still holds; no process holds a path inside it; no other
 *   worktree's symlinks point into it.
 * - Every check runs twice: once to report, and again for each candidate
 *   immediately before it is touched.
 * - A candidate is first moved into <root>/.gc-quarantine/ and then removed
 *   with `git worktree remove` (no --force). A removal killed half-way leaves
 *   a tree that is visibly ours: the next pass finishes it with --force
 *   instead of mistaking a half-deleted tree for somebody's dirty work.
 * - Branches are never deleted, local or remote.
 * - A pass stops starting removals near its time budget and after a capped
 *   number, so the unit's own timeout never lands mid-removal.
 *
 * OUTPUT
 * ------
 * One JSON line per worktree, then one summary line (last, for `tail -1`),
 * each far below journald's 48 KiB line limit. A Prometheus textfile carries
 * the pass result for alerting. Exit 0 when the pass completed, 3 when some
 * removal or the prune failed (a result, not a crash; the unit lists it in
 * SuccessExitStatus), 1 when the pass could not run at all (not a repository,
 * fetch failed, bad configuration) - nothing is removed in that case.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { heldWorktrees, scanProcessPaths } from './proc-scan.ts';
import {
  WORKTREE_LIST_ARGS,
  parseWorktreeList,
  shortBranch,
  type WorktreeRecord,
} from './worktree-list.ts';
import {
  canonical,
  isRebuildableCache,
  isStrictlyWithin,
  lastActivityMs,
  operationInProgress,
  symlinkTargetsOf,
  worktreeGitDir,
} from './worktree-state.ts';

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
  | 'operation_in_progress'
  | 'worktree_refs'
  | 'ref_check_failed'
  | 'merged_but_dirty'
  | 'ignored_content'
  | 'status_failed'
  | 'unreachable_reflog'
  | 'process_held'
  | 'proc_unreadable'
  | 'symlink_target'
  | 'pass_budget'
  | 'pass_cap'
  | 'quarantine_orphan'
  | 'quarantine_leftover'
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
}

/** The deploy checkout and its rollback worktrees. Not configurable away. */
export const BUILTIN_PROTECTED = ['/var/lib/aqua/deploy'];
export const QUARANTINE_DIR = '.gc-quarantine';
const BASE_REF = 'refs/remotes/origin/main';
const GIT_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 300_000;
const REMOVE_TIMEOUT_MS = 600_000;
/** No removal starts with less than this left in the pass budget. */
const MIN_REMAINING_MS = 60_000;
/** Reflog entries examined per worktree; a longer reflog keeps the worktree. */
const REFLOG_CAP = 2000;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_TEXTFILE = '/var/lib/node_exporter/textfile/aqua_worktree_gc.prom';
/** Kept reasons that are the normal state of a busy host, left out of the summary's attention list. */
const ROUTINE_REASONS: ReadonlySet<Reason> = new Set<Reason>([
  'main_checkout',
  'outside_roots',
  'protected_path',
  'unmerged',
  'recently_active',
  'locked',
]);
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

function numberEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number): number {
  const value = Number(env[key] ?? String(fallback));
  if (!Number.isFinite(value) || value < min) {
    throw new ConfigError(`${key}=${env[key]} must be a number >= ${min}`);
  }
  return value;
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
  if (!Number.isInteger(maxRemovals))
    throw new ConfigError('WORKTREE_GC_MAX_REMOVALS must be an integer');
  const armed = env.WORKTREE_GC_ARMED === '1';
  const textfile = env.WORKTREE_GC_TEXTFILE_PATH ?? DEFAULT_TEXTFILE;
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
    textfilePath: textfile === '' ? null : textfile,
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
  const timedOut = r.error !== undefined && 'code' in r.error && r.error.code === 'ETIMEDOUT';
  const stderr =
    `${r.stderr ?? ''}${timedOut ? ` timed out after ${timeout} ms` : r.error ? ` ${r.error.message}` : ''}`.trim();
  return { ok: r.status === 0 && !r.error, code: r.status, stdout: r.stdout ?? '', stderr };
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.slice(0, 300) ?? '';
}

/** Location rules only: no git and no filesystem reads beyond resolving the paths given. */
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

function quarantineDirs(config: GcConfig): string[] {
  return config.roots
    .map((r) => canonical(r))
    .filter((r): r is string => r !== null)
    .map((r) => join(r, QUARANTINE_DIR));
}

interface Verdict {
  reason: Reason;
  detail?: string;
}

interface Pass {
  config: GcConfig;
  base: string;
  records: WorktreeRecord[];
}

function gitIn(pass: Pass, cwd: string, args: string[]): GitResult {
  return git(pass.config.gitBin, ['-C', cwd, ...args]);
}

/** Commits the HEAD reflog reaches that no branch, tag or remote-tracking ref does. */
function reflogOnlyCommit(pass: Pass, real: string): Verdict | null {
  const log = gitIn(pass, real, ['log', '-g', '--format=%H', `-n${REFLOG_CAP}`, 'HEAD']);
  if (!log.ok) return { reason: 'ref_check_failed', detail: firstLine(log.stderr) };
  const entries = log.stdout.split('\n').filter(Boolean);
  if (entries.length >= REFLOG_CAP) {
    return { reason: 'ref_check_failed', detail: `reflog longer than ${REFLOG_CAP} entries` };
  }
  const shas = [...new Set(entries)];
  if (shas.length === 0) return null;
  const orphan = gitIn(pass, pass.config.repo, [
    'rev-list',
    '-n1',
    ...shas,
    '--not',
    '--branches',
    '--tags',
    '--remotes',
  ]);
  if (!orphan.ok) return { reason: 'ref_check_failed', detail: firstLine(orphan.stderr) };
  const sha = orphan.stdout.trim();
  return sha
    ? { reason: 'unreachable_reflog', detail: `${sha.slice(0, 12)} is held only by this reflog` }
    : null;
}

/** Every check except the process scan and symlink dependents. Re-run before each removal. */
function classify(record: WorktreeRecord, pass: Pass, now: number): Verdict {
  const { config } = pass;
  const real = canonical(record.path);
  const location = classifyLocation(record.path, real, config.roots, config.protectedPaths);
  if (location) return { reason: location };
  if (record.locked) return { reason: 'locked' };
  if (record.prunable || real === null) return { reason: 'missing' };
  const nested = pass.records.find(
    (other) => other !== record && isStrictlyWithin(canonical(other.path) ?? other.path, real),
  );
  if (nested) return { reason: 'contains_worktree', detail: nested.path };
  // Only this tool moves trees into quarantine, and only after every check
  // below passed. Whatever is left there is a removal that did not finish.
  if (quarantineDirs(config).some((q) => isStrictlyWithin(real, q))) {
    return { reason: 'quarantine_leftover' };
  }
  const gitDir = worktreeGitDir(real);
  if (!gitDir) return { reason: 'activity_unknown', detail: 'no readable .git file' };
  const head = gitIn(pass, real, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!head.ok) return { reason: 'merge_check_failed', detail: firstLine(head.stderr) };
  const ancestor = gitIn(pass, config.repo, [
    'merge-base',
    '--is-ancestor',
    head.stdout.trim(),
    pass.base,
  ]);
  if (ancestor.code === 1) return { reason: 'unmerged' };
  if (!ancestor.ok) return { reason: 'merge_check_failed', detail: firstLine(ancestor.stderr) };
  const activity = lastActivityMs(gitDir);
  if (activity === null) return { reason: 'activity_unknown' };
  if (now - activity < config.graceMs) {
    return {
      reason: 'recently_active',
      detail: `last activity ${new Date(activity).toISOString()}`,
    };
  }
  const operation = operationInProgress(gitDir);
  if (operation) return { reason: 'operation_in_progress', detail: operation };
  const refs = gitIn(pass, real, [
    'for-each-ref',
    '--count=1',
    '--format=%(refname)',
    'refs/worktree/',
    'refs/bisect/',
  ]);
  if (!refs.ok) return { reason: 'ref_check_failed', detail: firstLine(refs.stderr) };
  if (refs.stdout.trim()) return { reason: 'worktree_refs', detail: refs.stdout.trim() };
  const status = gitIn(pass, real, [
    '--no-optional-locks',
    'status',
    '--porcelain',
    '--ignored=matching',
    '--untracked-files=all',
  ]);
  if (!status.ok) return { reason: 'status_failed', detail: firstLine(status.stderr) };
  const lines = status.stdout.split('\n').filter(Boolean);
  const changes = lines.filter((l) => !l.startsWith('!! '));
  if (changes.length > 0) {
    return {
      reason: 'merged_but_dirty',
      detail: `${changes.length} uncommitted or untracked path(s)`,
    };
  }
  const keep = lines.map((l) => l.slice(3)).filter((p) => !isRebuildableCache(p));
  if (keep.length > 0) {
    return {
      reason: 'ignored_content',
      detail: `${keep.length} ignored non-cache path(s): ${keep.slice(0, 3).join(', ')}`,
    };
  }
  return reflogOnlyCommit(pass, real) ?? { reason: 'eligible' };
}

/** Another worktree whose symlinks resolve into the candidate, if any. */
function symlinkDependent(candidate: string, pass: Pass): string | null {
  for (const other of pass.records) {
    const dir = canonical(other.path);
    if (dir === null || dir === candidate || isStrictlyWithin(dir, candidate)) continue;
    const target = symlinkTargetsOf(dir).find(
      (t) => t === candidate || isStrictlyWithin(t, candidate),
    );
    if (target) return `${other.path} links into ${target}`;
  }
  return null;
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

function quarantineTarget(real: string, config: GcConfig, now: number): string | null {
  const dir = quarantineDirs(config).find((q) => isStrictlyWithin(real, dirname(q)));
  if (!dir) return null;
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return join(dir, `${stamp}-${basename(real)}`);
}

export interface Summary {
  schema: 'aqua/worktree-gc/v1';
  checked_at: string;
  repo: string;
  armed: boolean;
  dry_run: boolean;
  roots: string[];
  grace_hours: number;
  base: string | null;
  fatal: { kind: string; detail: string } | null;
  prune: 'ok' | 'failed' | 'skipped_dry_run' | 'skipped_prunable_outside_roots' | 'not_run';
  counts: Record<string, number>;
  bytes_reclaimed_estimate: number | null;
  removals: Array<{ path: string; decision: Decision; bytes: number | null; detail?: string }>;
  attention: Array<{ path: string; reason: Reason; detail?: string }>;
}

export interface PassResult {
  summary: Summary;
  reports: WorktreeReport[];
  exitCode: number;
}

function emptySummary(config: GcConfig, now: number): Summary {
  return {
    schema: 'aqua/worktree-gc/v1',
    checked_at: new Date(now).toISOString(),
    repo: config.repo,
    armed: config.armed,
    dry_run: config.dryRun,
    roots: config.roots,
    grace_hours: config.graceMs / HOUR_MS,
    base: null,
    fatal: null,
    prune: 'not_run',
    counts: {},
    bytes_reclaimed_estimate: null,
    removals: [],
    attention: [],
  };
}

function fatal(summary: Summary, kind: string, detail: string): PassResult {
  summary.fatal = { kind, detail };
  return { summary, reports: [], exitCode: 1 };
}

/** Quarantine entries git has no record of: a move that died between rename and bookkeeping. */
function quarantineOrphans(pass: Pass): WorktreeReport[] {
  const known = new Set(pass.records.map((r) => canonical(r.path) ?? r.path));
  const orphans: WorktreeReport[] = [];
  for (const dir of quarantineDirs(pass.config)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      if (known.has(canonical(path) ?? path)) continue;
      const report: WorktreeReport = {
        path,
        branch: null,
        head: null,
        decision: 'kept',
        reason: 'quarantine_orphan',
      };
      if (pass.config.dryRun) {
        report.detail = 'armed pass runs git worktree repair; the pass after removes it';
      } else {
        // Repair only rewrites git's link to the moved directory. The next
        // pass then sees an ordinary quarantine leftover and finishes it.
        const repair = git(pass.config.gitBin, [
          '-C',
          pass.config.repo,
          'worktree',
          'repair',
          path,
        ]);
        report.detail = repair.ok
          ? 'repaired; removed on the next pass'
          : `repair failed: ${firstLine(repair.stderr)}`;
      }
      orphans.push(report);
    }
  }
  return orphans;
}

/** Final re-check and removal of one candidate. Returns true when a removal was attempted. */
function act(
  report: WorktreeReport,
  record: WorktreeRecord,
  pass: Pass,
  started: number,
  sizeBudget: { ms: number },
): boolean {
  const { config } = pass;
  const verdict = classify(record, pass, Date.now());
  report.reason = verdict.reason;
  report.detail = verdict.detail;
  if (verdict.reason !== 'eligible' && verdict.reason !== 'quarantine_leftover') return false;
  const leftover = verdict.reason === 'quarantine_leftover';
  const real = canonical(record.path);
  if (real === null) {
    report.reason = 'missing';
    return false;
  }
  const scan = scanProcessPaths(config.procRoot);
  if (!scan.ok) {
    report.reason = 'proc_unreadable';
    report.detail = scan.detail;
    return false;
  }
  if (heldWorktrees(scan.paths, [real]).size > 0) {
    report.reason = 'process_held';
    return false;
  }
  const dependent = symlinkDependent(real, pass);
  if (dependent) {
    report.reason = 'symlink_target';
    report.detail = dependent;
    return false;
  }
  const remaining = config.passBudgetMs - (Date.now() - started);
  const measureStart = Date.now();
  report.bytes = measureBytes(real, Math.min(sizeBudget.ms, remaining - MIN_REMAINING_MS));
  sizeBudget.ms -= Date.now() - measureStart;
  if (config.dryRun) {
    report.decision = 'would_remove';
    return true;
  }
  let target = real;
  if (!leftover) {
    const quarantine = quarantineTarget(real, config, Date.now());
    if (!quarantine) {
      report.decision = 'remove_failed';
      report.detail = 'no quarantine directory under any root';
      return true;
    }
    mkdirSync(dirname(quarantine), { recursive: true });
    const move = git(config.gitBin, [
      '-C',
      config.repo,
      'worktree',
      'move',
      record.path,
      quarantine,
    ]);
    if (!move.ok) {
      report.decision = 'remove_failed';
      report.detail = `move to quarantine failed: ${firstLine(move.stderr)}`;
      return true;
    }
    target = quarantine;
  }
  // A leftover is a tree this tool already judged and began deleting; --force
  // finishes it. A fresh candidate gets no --force, so git refuses anything
  // that turned dirty after the re-check.
  const args = ['-C', config.repo, 'worktree', 'remove', ...(leftover ? ['--force'] : []), target];
  const left = config.passBudgetMs - (Date.now() - started);
  const removal = git(config.gitBin, args, Math.max(1000, Math.min(REMOVE_TIMEOUT_MS, left)));
  if (removal.ok) {
    report.decision = 'removed';
    if (leftover) report.detail = 'finished an interrupted removal';
  } else {
    report.decision = 'remove_failed';
    report.detail = `${firstLine(removal.stderr)}${target !== real ? `; left in ${target}, finished next pass` : ''}`;
  }
  return true;
}

function prunableOutsideRoots(records: WorktreeRecord[], config: GcConfig): boolean {
  return records.some(
    (r, i) =>
      i > 0 &&
      r.prunable &&
      classifyLocation(r.path, null, config.roots, config.protectedPaths) !== null,
  );
}

export function run(config: GcConfig, now: number = Date.now()): PassResult {
  const started = Date.now();
  const summary = emptySummary(config, now);
  const probe = git(config.gitBin, ['-C', config.repo, 'rev-parse', '--git-common-dir']);
  if (!probe.ok) return fatal(summary, 'not_a_repo', firstLine(probe.stderr));

  // "Merged" means merged into the origin/main that exists now; a failed
  // fetch means we cannot say that, so nothing is removed.
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
  const pass: Pass = { config, base, records };
  const mainReal = canonical(config.repo) ?? config.repo;

  const entries = records.map((record, index) => {
    const report: WorktreeReport = {
      path: record.path,
      branch: shortBranch(record.branch),
      head: record.head?.slice(0, 12) ?? null,
      decision: 'kept',
      reason: 'main_checkout',
    };
    // git lists the main checkout (or the bare repository) first, always.
    if (!(index === 0 || record.bare || canonical(record.path) === mainReal)) {
      Object.assign(report, classify(record, pass, now));
    }
    return { report, record };
  });
  const reports = [...entries.map((e) => e.report), ...quarantineOrphans(pass)];

  // Leftovers first: they are space this tool already committed to freeing.
  const candidates = entries
    .filter((e) => e.report.reason === 'quarantine_leftover' || e.report.reason === 'eligible')
    .sort(
      (a, b) =>
        Number(b.report.reason === 'quarantine_leftover') -
        Number(a.report.reason === 'quarantine_leftover'),
    );
  let attempts = 0;
  const sizeBudget = { ms: config.sizeBudgetMs };
  for (const { report, record } of candidates) {
    if (attempts >= config.maxRemovals) {
      report.reason = 'pass_cap';
      report.detail = `${config.maxRemovals} removals per pass`;
      continue;
    }
    if (config.passBudgetMs - (Date.now() - started) < MIN_REMAINING_MS) {
      report.reason = 'pass_budget';
      report.detail = 'not started: too little of the pass budget left';
      continue;
    }
    if (act(report, record, pass, started, sizeBudget)) attempts += 1;
  }

  if (config.dryRun) {
    summary.prune = 'skipped_dry_run';
  } else {
    // Re-listed: removals above changed the set, and a worktree outside our
    // roots that now reads as missing may sit on a mount this process cannot
    // see. Pruning would destroy its record; that is not this tool's call.
    const fresh = git(config.gitBin, ['-C', config.repo, ...WORKTREE_LIST_ARGS]);
    if (!fresh.ok || prunableOutsideRoots(parseWorktreeList(fresh.stdout), config)) {
      summary.prune = 'skipped_prunable_outside_roots';
    } else {
      const prune = git(config.gitBin, ['-C', config.repo, 'worktree', 'prune']);
      summary.prune = prune.ok ? 'ok' : 'failed';
    }
  }

  const removals = reports.filter((r) => r.decision !== 'kept');
  const reclaimed = removals.filter((r) => r.decision !== 'remove_failed');
  summary.bytes_reclaimed_estimate = reclaimed.some(
    (r) => r.bytes === null || r.bytes === undefined,
  )
    ? null
    : reclaimed.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
  summary.removals = removals.map((r) => ({
    path: r.path,
    decision: r.decision,
    bytes: r.bytes ?? null,
    ...(r.detail ? { detail: r.detail } : {}),
  }));
  summary.attention = reports
    .filter((r) => r.decision === 'kept' && !ROUTINE_REASONS.has(r.reason))
    .map((r) => ({ path: r.path, reason: r.reason, ...(r.detail ? { detail: r.detail } : {}) }));
  const counts: Record<string, number> = { total: reports.length };
  for (const r of reports) {
    const key = r.decision === 'kept' ? `kept_${r.reason}` : r.decision;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  summary.counts = counts;
  const failed = reports.some((r) => r.decision === 'remove_failed') || summary.prune === 'failed';
  return { summary, reports, exitCode: failed ? 3 : 0 };
}

function writeTextfile(path: string | null, result: PassResult, armed: boolean): void {
  if (path === null) return;
  const counts = result.summary.counts;
  const lines = [
    '# HELP aqua_worktree_gc_last_run_timestamp_seconds Unix time of the last worktree-gc pass',
    '# TYPE aqua_worktree_gc_last_run_timestamp_seconds gauge',
    `aqua_worktree_gc_last_run_timestamp_seconds ${Math.floor(Date.now() / 1000)}`,
    '# HELP aqua_worktree_gc_last_exit_code 0 ok, 3 a removal or the prune failed, 1 the pass could not run',
    '# TYPE aqua_worktree_gc_last_exit_code gauge',
    `aqua_worktree_gc_last_exit_code ${result.exitCode}`,
    '# HELP aqua_worktree_gc_armed 1 when the pass may remove worktrees',
    '# TYPE aqua_worktree_gc_armed gauge',
    `aqua_worktree_gc_armed ${armed ? 1 : 0}`,
    '# HELP aqua_worktree_gc_worktrees Worktrees on the last pass, by outcome',
    '# TYPE aqua_worktree_gc_worktrees gauge',
    `aqua_worktree_gc_worktrees{outcome="removed"} ${counts.removed ?? 0}`,
    `aqua_worktree_gc_worktrees{outcome="would_remove"} ${counts.would_remove ?? 0}`,
    `aqua_worktree_gc_worktrees{outcome="remove_failed"} ${counts.remove_failed ?? 0}`,
    `aqua_worktree_gc_worktrees{outcome="attention"} ${result.summary.attention.length}`,
    '# HELP aqua_worktree_gc_bytes_reclaimed_estimate Bytes removed (or removable) on the last pass; -1 unmeasured',
    '# TYPE aqua_worktree_gc_bytes_reclaimed_estimate gauge',
    `aqua_worktree_gc_bytes_reclaimed_estimate ${result.summary.bytes_reclaimed_estimate ?? -1}`,
  ];
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, `${lines.join('\n')}\n`, 'utf8');
    renameSync(`${path}.tmp`, path);
  } catch {
    // The journal line still carries everything; a missing textfile
    // directory must not turn a completed pass into a failure.
  }
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
  const result = run(config);
  // One line per worktree, then the summary: journald splits a line longer
  // than LineMax (48 KiB) into fragments that no longer parse.
  for (const report of result.reports) {
    process.stdout.write(
      `${JSON.stringify({ schema: 'aqua/worktree-gc/worktree/v1', checked_at: result.summary.checked_at, ...report })}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(result.summary)}\n`);
  writeTextfile(config.textfilePath, result, config.armed);
  return result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main();
}
