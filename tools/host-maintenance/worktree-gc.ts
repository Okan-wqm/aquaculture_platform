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
 * - A candidate is measured (du) first, then re-checked, then moved into
 *   <root>/.gc-quarantine/ and removed with `git worktree remove` (no
 *   --force). If git refuses, the tree is moved back and kept
 *   (remove_refused). A removal that timed out or was killed is finished by
 *   a later pass with --force, but only while its status shows nothing but
 *   deleted tracked files and allow-listed caches and its reflog, refs and
 *   operation checks still pass. A tree whose .git file git already deleted
 *   is cleared directly (gc-quarantine.ts).
 * - Branches are never deleted, local or remote.
 * - A pass stops starting removals near its time budget and after a capped
 *   number, so the unit's own timeout never lands mid-removal.
 *
 * OUTPUT
 * ------
 * One JSON line per worktree, then one summary line (last, for `tail -1`),
 * each far below journald's 48 KiB line limit. A Prometheus textfile carries
 * the pass result for alerting. Exit 0 when the pass completed, 3 when some
 * removal was refused or failed, or the prune failed (a result, not a crash; the unit lists it in
 * SuccessExitStatus), 1 when the pass could not run at all (not a repository,
 * fetch failed, bad configuration) - nothing is removed in that case.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ConfigError,
  HOUR_MS,
  classifyLocation,
  readConfig,
  textfilePathFrom,
  type GcConfig,
} from './gc-config.ts';
import { firstLine, git, type GitResult } from './gc-git.ts';
import { writeTextfile } from './gc-metrics.ts';
import {
  clearStranded,
  isStranded,
  quarantineDirs,
  quarantineOf,
  quarantineTarget,
} from './gc-quarantine.ts';
import { heldWorktrees, scanProcessPaths } from './proc-scan.ts';
import {
  WORKTREE_LIST_ARGS,
  parseWorktreeList,
  shortBranch,
  type WorktreeRecord,
} from './worktree-list.ts';
import {
  ARIA_PATHSPECS,
  ariaName,
  canonical,
  headRef,
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
  | 'aria'
  | 'process_held'
  | 'proc_unreadable'
  | 'symlink_target'
  | 'pass_budget'
  | 'pass_cap'
  | 'remove_refused'
  | 'quarantine_orphan'
  | 'quarantine_leftover'
  | 'quarantine_stranded'
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

const BASE_REF = 'refs/remotes/origin/main';
const FETCH_TIMEOUT_MS = 300_000;
const REMOVE_TIMEOUT_MS = 600_000;
/** No removal starts with less than this left in the pass budget. */
const MIN_REMAINING_MS = 60_000;
/** Reflog entries examined per worktree; a longer reflog keeps the worktree. */
const REFLOG_CAP = 2000;
/** Reasons a worktree may be acted on in the final phase. */
const ACTIONABLE: ReadonlySet<Reason> = new Set<Reason>([
  'eligible',
  'quarantine_leftover',
  'quarantine_stranded',
]);
/** Kept reasons that are the normal state of a busy host, left out of the summary's attention list. */
const ROUTINE_REASONS: ReadonlySet<Reason> = new Set<Reason>([
  'main_checkout',
  'outside_roots',
  'protected_path',
  'unmerged',
  'recently_active',
  'locked',
]);

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

function headVerdict(pass: Pass, real: string): Verdict | null {
  const head = gitIn(pass, real, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!head.ok) return { reason: 'merge_check_failed', detail: firstLine(head.stderr) };
  const sha = head.stdout.trim();
  const ancestor = gitIn(pass, pass.config.repo, ['merge-base', '--is-ancestor', sha, pass.base]);
  if (ancestor.code === 1) return { reason: 'unmerged' };
  if (!ancestor.ok) return { reason: 'merge_check_failed', detail: firstLine(ancestor.stderr) };
  return null;
}

/** A half-done rebase/merge/cherry-pick/revert/bisect, or refs of its own. */
function refsVerdict(pass: Pass, real: string, gitDir: string): Verdict | null {
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
  return null;
}

/**
 * What `git status` shows. `allowDeleted` accepts ` D` (tracked file deleted
 * from the tree): that is what an interrupted `git worktree remove` leaves,
 * and is accepted only for a tree in quarantine.
 */
function contentVerdict(pass: Pass, real: string, allowDeleted: boolean): Verdict | null {
  const status = gitIn(pass, real, [
    '--no-optional-locks',
    'status',
    '--porcelain',
    '--ignored=matching',
    '--untracked-files=all',
  ]);
  if (!status.ok) return { reason: 'status_failed', detail: firstLine(status.stderr) };
  const lines = status.stdout.split('\n').filter(Boolean);
  const changes = lines.filter(
    (l) => !l.startsWith('!! ') && !(allowDeleted && l.startsWith(' D ')),
  );
  if (changes.length > 0) {
    return {
      reason: 'merged_but_dirty',
      detail: `${changes.length} uncommitted or untracked path(s): ${changes.slice(0, 3).join(', ')}`,
    };
  }
  const keep = lines
    .filter((l) => l.startsWith('!! '))
    .map((l) => l.slice(3))
    .filter((p) => !isRebuildableCache(p));
  if (keep.length > 0) {
    return {
      reason: 'ignored_content',
      detail: `${keep.length} ignored non-cache path(s): ${keep.slice(0, 3).join(', ')}`,
    };
  }
  return null;
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

/**
 * A tree the collector moved into quarantine and did not finish removing.
 * It is finished with --force only if nothing but the removal touched it:
 * same merged HEAD, no operation or refs, no change except deleted tracked
 * files and allow-listed caches, no reflog-only commit. Anything else is
 * somebody's work and keeps it.
 */
function classifyLeftover(pass: Pass, real: string): Verdict {
  const gitDir = worktreeGitDir(real);
  if (!gitDir) return { reason: 'activity_unknown', detail: 'no readable .git file' };
  return (
    headVerdict(pass, real) ??
    refsVerdict(pass, real, gitDir) ??
    contentVerdict(pass, real, true) ??
    reflogOnlyCommit(pass, real) ?? { reason: 'quarantine_leftover' }
  );
}

/**
 * ARIA-specific structures are never removed or quarantined (user decision,
 * 2026-10-09): an ARIA branch or directory name, or an untracked or ignored
 * file under an ARIA artifact path that only this worktree holds
 * (worktree-state.ts spells out the matchers and paths).
 */
function ariaVerdict(record: WorktreeRecord, real: string | null, pass: Pass): Verdict | null {
  const gitDir = real === null ? null : worktreeGitDir(real);
  const ref = (gitDir === null ? null : headRef(gitDir)) ?? record.branch;
  const name = ariaName(ref, real ?? record.path) ?? ariaName(null, record.path);
  if (name) return { reason: 'aria', detail: name };
  if (real === null) return null;
  // No .git file: only a tree this collector moved into quarantine after it
  // passed this same check (then readable by git) ends up like this.
  if (isStranded(real)) return null;
  const status = gitIn(pass, real, [
    '--no-optional-locks',
    'status',
    '--porcelain',
    '--ignored=matching',
    '--untracked-files=all',
    '--',
    ...ARIA_PATHSPECS,
  ]);
  if (!status.ok) return { reason: 'status_failed', detail: firstLine(status.stderr) };
  const own = status.stdout.split('\n').find((l) => l.startsWith('?? ') || l.startsWith('!! '));
  return own
    ? { reason: 'aria', detail: `holds ${own.slice(3)}, which only this worktree has` }
    : null;
}

/** Every check except the process scan and symlink dependents. Re-run before each removal. */
function classify(record: WorktreeRecord, pass: Pass, now: number): Verdict {
  const { config } = pass;
  const real = canonical(record.path);
  const location = classifyLocation(record.path, real, config.roots, config.protectedPaths);
  if (location) return { reason: location };
  if (record.locked) return { reason: 'locked' };
  const aria = ariaVerdict(record, real, pass);
  if (aria) return aria;
  if (quarantineOf(record.path, config.roots)) {
    if (real === null || isStranded(real)) return { reason: 'quarantine_stranded' };
    return classifyLeftover(pass, real);
  }
  if (record.prunable || real === null) return { reason: 'missing' };
  const nested = pass.records.find(
    (other) => other !== record && isStrictlyWithin(canonical(other.path) ?? other.path, real),
  );
  if (nested) return { reason: 'contains_worktree', detail: nested.path };
  const gitDir = worktreeGitDir(real);
  if (!gitDir) return { reason: 'activity_unknown', detail: 'no readable .git file' };
  const head = headVerdict(pass, real);
  if (head) return head;
  const activity = lastActivityMs(gitDir);
  if (activity === null) return { reason: 'activity_unknown' };
  if (now - activity < config.graceMs) {
    return {
      reason: 'recently_active',
      detail: `last activity ${new Date(activity).toISOString()}`,
    };
  }
  return (
    refsVerdict(pass, real, gitDir) ??
    contentVerdict(pass, real, false) ??
    reflogOnlyCommit(pass, real) ?? { reason: 'eligible' }
  );
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

/** Why a live process or another worktree still needs `real`, or null. */
function inUse(real: string, pass: Pass): Verdict | null {
  const scan = scanProcessPaths(pass.config.procRoot);
  if (!scan.ok) return { reason: 'proc_unreadable', detail: scan.detail };
  if (heldWorktrees(scan.paths, [real]).size > 0) return { reason: 'process_held' };
  const dependent = symlinkDependent(real, pass);
  return dependent ? { reason: 'symlink_target', detail: dependent } : null;
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

/**
 * Quarantine entries git has no record of. Without a .git file the move
 * finished and the removal was killed after git forgot the tree: cleared
 * directly. With one, the move itself was killed between the rename and
 * git's bookkeeping: `git worktree repair` relinks it, and the next pass
 * judges it as an ordinary leftover.
 */
function quarantineOrphans(pass: Pass): WorktreeReport[] {
  const { config } = pass;
  const known = new Set(pass.records.map((r) => canonical(r.path) ?? r.path));
  const orphans: WorktreeReport[] = [];
  for (const quarantine of quarantineDirs(config.roots)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(quarantine);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(quarantine, entry);
      if (known.has(canonical(path) ?? path)) continue;
      const report: WorktreeReport = {
        path,
        branch: null,
        head: null,
        decision: 'kept',
        reason: 'quarantine_orphan',
      };
      orphans.push(report);
      // Content is judged by git once the tree is readable again (next pass).
      const aria = ariaName(null, path);
      if (aria) {
        report.reason = 'aria';
        report.detail = aria;
        continue;
      }
      if (isStranded(path)) {
        report.reason = 'quarantine_stranded';
        const busy = inUse(canonical(path) ?? path, pass);
        if (busy) Object.assign(report, busy);
        else if (config.dryRun) report.decision = 'would_remove';
        else {
          const error = clearStranded(null, path, quarantine, config.repo, config.gitBin);
          report.decision = error ? 'remove_failed' : 'removed';
          if (error) report.detail = error;
        }
        continue;
      }
      if (config.dryRun) {
        report.detail = 'an armed pass runs git worktree repair; the pass after judges it';
        continue;
      }
      const repair = git(config.gitBin, ['-C', config.repo, 'worktree', 'repair', path]);
      report.detail = repair.ok
        ? 'repaired; judged on the next pass'
        : `repair failed: ${firstLine(repair.stderr)}`;
    }
  }
  return orphans;
}

/** Removes a fresh candidate through the quarantine; a refusal moves it back. */
function removeViaQuarantine(
  report: WorktreeReport,
  record: WorktreeRecord,
  real: string,
  pass: Pass,
  timeoutMs: number,
): void {
  const { config } = pass;
  const quarantine = quarantineTarget(real, config.roots, Date.now());
  if (!quarantine) {
    report.decision = 'remove_failed';
    report.detail = 'no quarantine directory under any root';
    return;
  }
  try {
    mkdirSync(dirname(quarantine), { recursive: true });
  } catch (error) {
    // ENOSPC and friends: report it, never crash the pass before its textfile.
    report.decision = 'remove_failed';
    report.detail = `cannot create quarantine: ${firstLine(error instanceof Error ? error.message : String(error))}`;
    return;
  }
  const move = git(config.gitBin, ['-C', config.repo, 'worktree', 'move', record.path, quarantine]);
  if (!move.ok) {
    report.decision = 'remove_failed';
    report.detail = `move to quarantine failed: ${firstLine(move.stderr)}`;
    return;
  }
  const removal = git(
    config.gitBin,
    ['-C', config.repo, 'worktree', 'remove', quarantine],
    timeoutMs,
  );
  if (removal.ok) {
    report.decision = 'removed';
    return;
  }
  if (removal.timedOut) {
    report.decision = 'remove_failed';
    report.detail = `${firstLine(removal.stderr)}; left in ${quarantine} for the next pass`;
    return;
  }
  // git stopped without a timeout. If it had already begun deleting (EBUSY,
  // EPERM half-way), the tree is no longer anybody's intact work: it stays in
  // quarantine and a later pass finishes it under the leftover rules. Only an
  // untouched tree - a refusal because something appeared after the re-check
  // - goes back where its owner left it.
  const after = gitIn(pass, quarantine, ['--no-optional-locks', 'status', '--porcelain']);
  const started = !after.ok || after.stdout.split('\n').some((l) => l.startsWith(' D '));
  if (started) {
    report.decision = 'remove_failed';
    report.detail = `${firstLine(removal.stderr)}; removal had begun, left in ${quarantine} for the next pass`;
    return;
  }
  const back = git(config.gitBin, ['-C', config.repo, 'worktree', 'move', quarantine, record.path]);
  if (back.ok) {
    report.reason = 'remove_refused';
    report.detail = firstLine(removal.stderr);
    return;
  }
  report.decision = 'remove_failed';
  report.detail = `refused (${firstLine(removal.stderr)}) and could not move back from ${quarantine}: ${firstLine(back.stderr)}`;
}

/** Final measurement, re-check and action for one candidate. Returns true when it counted toward the cap. */
function act(
  report: WorktreeReport,
  record: WorktreeRecord,
  pass: Pass,
  started: number,
  sizeBudget: { ms: number },
): boolean {
  const { config } = pass;
  const before = canonical(record.path);
  // Measured first: everything between the final checks and the move must
  // be as short as possible, and du on a large tree is not.
  const measureStart = Date.now();
  const left = config.passBudgetMs - (Date.now() - started);
  report.bytes =
    before === null ? 0 : measureBytes(before, Math.min(sizeBudget.ms, left - MIN_REMAINING_MS));
  sizeBudget.ms -= Date.now() - measureStart;

  const verdict = classify(record, pass, Date.now());
  report.reason = verdict.reason;
  report.detail = verdict.detail;
  if (!ACTIONABLE.has(verdict.reason)) return false;
  const real = canonical(record.path);
  if (real !== null) {
    const busy = inUse(real, pass);
    if (busy) {
      report.reason = busy.reason;
      report.detail = busy.detail;
      return false;
    }
  }
  if (config.dryRun) {
    report.decision = 'would_remove';
    return true;
  }
  const timeoutMs = Math.max(
    1000,
    Math.min(REMOVE_TIMEOUT_MS, config.passBudgetMs - (Date.now() - started)),
  );
  if (verdict.reason === 'quarantine_stranded') {
    const quarantine = quarantineOf(record.path, config.roots);
    const error = quarantine
      ? clearStranded(record.path, real ?? record.path, quarantine, config.repo, config.gitBin)
      : 'not in a quarantine directory';
    report.decision = error ? 'remove_failed' : 'removed';
    report.detail = error ?? 'cleared a removal git had half done';
    return true;
  }
  if (verdict.reason === 'quarantine_leftover' && real !== null) {
    // Judged above to hold nothing but what the interrupted removal left.
    const removal = git(
      config.gitBin,
      ['-C', config.repo, 'worktree', 'remove', '--force', real],
      timeoutMs,
    );
    report.decision = removal.ok ? 'removed' : 'remove_failed';
    report.detail = removal.ok ? 'finished an interrupted removal' : firstLine(removal.stderr);
    return true;
  }
  if (real === null) return false;
  removeViaQuarantine(report, record, real, pass, timeoutMs);
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

  // Quarantine first: that is space this tool already committed to freeing.
  const fresh = (e: { report: WorktreeReport }): number => Number(e.report.reason === 'eligible');
  const candidates = entries
    .filter((e) => ACTIONABLE.has(e.report.reason))
    .sort((a, b) => fresh(a) - fresh(b));
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
    const relist = git(config.gitBin, ['-C', config.repo, ...WORKTREE_LIST_ARGS]);
    if (!relist.ok || prunableOutsideRoots(parseWorktreeList(relist.stdout), config)) {
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
  const partial =
    reports.some((r) => r.decision === 'remove_failed' || r.reason === 'remove_refused') ||
    summary.prune === 'failed';
  return { summary, reports, exitCode: partial ? 3 : 0 };
}

function outcomes(
  result: PassResult,
): Record<'removed' | 'would_remove' | 'remove_failed' | 'remove_refused' | 'attention', number> {
  const c = result.summary.counts;
  return {
    removed: c.removed ?? 0,
    would_remove: c.would_remove ?? 0,
    remove_failed: c.remove_failed ?? 0,
    remove_refused: c.kept_remove_refused ?? 0,
    attention: result.summary.attention.length,
  };
}

const NO_OUTCOMES = {
  removed: 0,
  would_remove: 0,
  remove_failed: 0,
  remove_refused: 0,
  attention: 0,
};

function message(error: unknown): string {
  return firstLine(error instanceof Error ? error.message : String(error));
}

/**
 * One pass, end to end: configuration, the pass itself, the journal lines
 * and the textfile. Whatever goes wrong - bad configuration, or an exception
 * nothing anticipated (ENOSPC on the very disk this tool exists for) - the
 * pass still prints a fatal summary and writes the textfile with exit 1, so
 * the alerts see a failing collector rather than a silent one.
 */
export function executePass(
  argv: string[],
  env: NodeJS.ProcessEnv,
  write: (line: string) => void,
  runPass: (config: GcConfig) => PassResult = run,
): number {
  const failed = (
    kind: string,
    detail: string,
    armed: boolean,
    textfile: string | null,
  ): number => {
    write(`${JSON.stringify({ schema: 'aqua/worktree-gc/v1', fatal: { kind, detail } })}\n`);
    writeTextfile(textfile, { exitCode: 1, armed, outcomes: NO_OUTCOMES, bytesReclaimed: null });
    return 1;
  };
  let config: GcConfig;
  try {
    config = readConfig(argv, env);
  } catch (error) {
    const kind = error instanceof ConfigError ? 'bad_config' : 'crash';
    return failed(kind, message(error), env.WORKTREE_GC_ARMED === '1', textfilePathFrom(env));
  }
  let result: PassResult;
  try {
    result = runPass(config);
  } catch (error) {
    return failed('crash', message(error), config.armed, config.textfilePath);
  }
  // One line per worktree, then the summary: journald splits a line longer
  // than LineMax (48 KiB) into fragments that no longer parse.
  for (const report of result.reports) {
    write(
      `${JSON.stringify({ schema: 'aqua/worktree-gc/worktree/v1', checked_at: result.summary.checked_at, ...report })}\n`,
    );
  }
  write(`${JSON.stringify(result.summary)}\n`);
  writeTextfile(config.textfilePath, {
    exitCode: result.exitCode,
    armed: config.armed,
    outcomes: outcomes(result),
    bytesReclaimed: result.summary.bytes_reclaimed_estimate,
  });
  return result.exitCode;
}

function main(): number {
  return executePass(process.argv.slice(2), process.env, (line) => {
    process.stdout.write(line);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main();
}
