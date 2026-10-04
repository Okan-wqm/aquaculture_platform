#!/usr/bin/env ts-node
/**
 * kernel-budget — the ARIA kernel growth gate (ADR-0025).
 * =======================================================
 *
 * # Why
 *
 * Program constraint K-4′ capped ARIA kernel growth and named this file's
 * policy, `docs/aria/policy/kernel-budget.json`, as its CI gate. The policy
 * never existed and nothing measured the kernel, so the budget was exceeded
 * before anyone could see it: 4,784 gross non-test kernel lines merged in the
 * ten changes after the K1 merge, three of them over the per-PR cap (#1729
 * +1,293, #1741 +1,145, #1723 +536). ADR-0025 sets the ceiling on that
 * measured base; this gate is what makes the ceiling a fact instead of a
 * sentence.
 *
 * # What is measured
 *
 * Kernel source is every file under `aria-kernel/aria_kernel/` that is not a
 * test (`tests/` or `test/` directories, `test_*.py`, `*_test.py`,
 * `conftest.py`). A module is a kernel-source `*.py` file. Renames count as a
 * deletion plus an addition (`--no-renames`), the way every kernel path reader
 * sees them.
 *
 * - **Charge of one change** = gross added lines − max(0, deleted − added).
 *   Deletions earn credit only for the lines they exceed additions by, so a
 *   rewrite (+600/−600) is charged 600 and earns nothing; a removal (+5/−500)
 *   is charged −490.
 * - **Merged measure** = the sum of the charges of every first-parent change on
 *   the base ref after `base_sha`. Credit therefore exists only for deletions
 *   that are merged: a deletion on an open branch, or one promised for later,
 *   moves nothing.
 * - **This change** = the diff from merge-base(base ref, head) to head. On a
 *   pull_request run head is GitHub's synthetic merge commit, so the merge
 *   base is the base tip and the diff is exactly the PR.
 * - **Projected** = merged measure + this change's charge (lines), and
 *   merged module delta + this change's module delta (modules).
 *
 * # Limits (all from the policy)
 *
 * - per change: gross added ≤ `per_pr_max.kernel_lines`, module delta ≤
 *   `per_pr_max.module_net`. A PR named in `predating_prs` (number AND branch)
 *   is allowed up to its recorded measurement instead, never more.
 * - cumulative: projected ≤ `ceiling.kernel_lines` and ≤ `ceiling.module_net`,
 *   checked when this change adds to the measure (a change that only removes
 *   is never blocked) and on a push run (head = base ref), where it is main's
 *   own verdict.
 *
 * # Changing the policy
 *
 * The policy is read from head. A policy that differs from the base ref's is
 * honoured only when the change only tightens it (lower limits, fewer
 * predating entries) or when the same diff adds or modifies an ADR the head
 * policy lists in `adr_refs`. Otherwise the change is a violation and the
 * limits are evaluated with the base ref's policy, so the overrun the edit
 * tried to cover is reported next to it.
 *
 * # Invocation
 *
 *   ts-node --project tools/gates/tsconfig.json tools/gates/kernel-budget.ts \
 *     [--base-ref <rev>=origin/main] [--head <rev>=HEAD] [--pr-number <n>] \
 *     [--head-ref <branch>] [--repo-root <dir>] [--json]
 *
 * Exit codes: 0 within budget; 1 a limit is exceeded or the policy changed
 * without an ADR; 2 environment or invocation error (missing or malformed
 * policy, unknown policy key, a base the head does not descend from).
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { repoPinnedEnv } from './git-reachability';

const KERNEL_ROOT = 'aria-kernel/aria_kernel/';
const POLICY_PATH = 'docs/aria/policy/kernel-budget.json';
const POLICY_SCHEMA = 'aria/kernel-budget/v1';
const ADR_PATH_PATTERN =
  /^docs\/recommendations\/architectural-arbiter\/\d{4}-\d{2}-\d{2}-adr-\d{4}-[a-z0-9-]+\.md$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MERGE_SUBJECT_PR = /^Merge pull request #(\d+) /;
const SQUASH_SUBJECT_PR = /\(#(\d+)\)$/;

class GateEnvironmentError extends Error {}

// ---------------------------------------------------------------------------
// Policy shape (aria/kernel-budget/v1) — strict: an unknown key fails closed.
// ---------------------------------------------------------------------------

interface BaseException {
  readonly pr: number;
  readonly branch: string;
  readonly merge_sha: string;
  readonly kernel_added: number;
  readonly kernel_deleted: number;
  readonly reason: string;
}

interface Limits {
  readonly kernel_lines: number;
  readonly module_net: number;
}

interface Measurement {
  readonly main_sha: string;
  readonly measured_on: string;
  readonly merged_kernel_lines: number;
  readonly open_predating_kernel_lines: number;
  readonly rev3_min_estimate_kernel_lines: number;
}

interface PredatingPr {
  readonly number: number;
  readonly branch: string;
  readonly head_sha: string;
  readonly kernel_added: number;
  readonly kernel_deleted: number;
  readonly module_delta: number;
}

interface Policy {
  readonly $schema: string;
  readonly schema_version: 1;
  readonly status: 'proposed' | 'accepted';
  readonly adr_refs: readonly string[];
  readonly base_sha: string;
  readonly base_exception: BaseException;
  readonly ceiling: Limits;
  readonly per_pr_max: Limits;
  readonly measurement: Measurement;
  readonly predating_prs: readonly PredatingPr[];
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown, where: string, keys: readonly string[]): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GateEnvironmentError(`${where} must be an object`);
  }
  const record = value as JsonObject;
  const unknown = Object.keys(record).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    throw new GateEnvironmentError(`${where} has unknown key(s): ${unknown.join(', ')}`);
  }
  const missing = keys.filter((key) => !(key in record));
  if (missing.length > 0) {
    throw new GateEnvironmentError(`${where} is missing key(s): ${missing.join(', ')}`);
  }
  return record;
}

function count(value: unknown, where: string, allowNegative = false): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || (!allowNegative && value < 0)) {
    throw new GateEnvironmentError(
      `${where} must be ${allowNegative ? 'an integer' : 'a non-negative integer'}`,
    );
  }
  return value;
}

function text(value: unknown, where: string, pattern?: RegExp): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    throw new GateEnvironmentError(
      `${where} must be a ${pattern ? `string matching ${String(pattern)}` : 'non-empty string'}`,
    );
  }
  return value;
}

function parseLimits(value: unknown, where: string, allowNegativeModules: boolean): Limits {
  const record = asObject(value, where, ['kernel_lines', 'module_net']);
  return {
    kernel_lines: count(record.kernel_lines, `${where}.kernel_lines`),
    module_net: count(record.module_net, `${where}.module_net`, allowNegativeModules),
  };
}

export function parsePolicy(raw: unknown, source: string): Policy {
  const root = asObject(raw, source, [
    '$schema',
    'schema_version',
    'status',
    'adr_refs',
    'base_sha',
    'base_exception',
    'ceiling',
    'per_pr_max',
    'measurement',
    'predating_prs',
  ]);
  if (root.$schema !== POLICY_SCHEMA)
    throw new GateEnvironmentError(`${source}.$schema must be ${POLICY_SCHEMA}`);
  if (root.schema_version !== 1)
    throw new GateEnvironmentError(`${source}.schema_version must be 1`);
  if (root.status !== 'proposed' && root.status !== 'accepted') {
    throw new GateEnvironmentError(`${source}.status must be "proposed" or "accepted"`);
  }
  if (!Array.isArray(root.adr_refs) || root.adr_refs.length === 0) {
    throw new GateEnvironmentError(`${source}.adr_refs must list at least one ADR`);
  }
  const adrRefs = root.adr_refs.map((ref, index) =>
    text(ref, `${source}.adr_refs[${index}]`, ADR_PATH_PATTERN),
  );
  const baseSha = text(root.base_sha, `${source}.base_sha`, SHA_PATTERN);

  const exception = asObject(root.base_exception, `${source}.base_exception`, [
    'pr',
    'branch',
    'merge_sha',
    'kernel_added',
    'kernel_deleted',
    'reason',
  ]);
  const baseException: BaseException = {
    pr: count(exception.pr, `${source}.base_exception.pr`),
    branch: text(exception.branch, `${source}.base_exception.branch`),
    merge_sha: text(exception.merge_sha, `${source}.base_exception.merge_sha`, SHA_PATTERN),
    kernel_added: count(exception.kernel_added, `${source}.base_exception.kernel_added`),
    kernel_deleted: count(exception.kernel_deleted, `${source}.base_exception.kernel_deleted`),
    reason: text(exception.reason, `${source}.base_exception.reason`),
  };
  // The exception IS the base: the measure starts after the excepted change.
  if (baseException.merge_sha !== baseSha) {
    throw new GateEnvironmentError(
      `${source}.base_exception.merge_sha must equal base_sha (${baseSha})`,
    );
  }

  const measurementRecord = asObject(root.measurement, `${source}.measurement`, [
    'main_sha',
    'measured_on',
    'merged_kernel_lines',
    'open_predating_kernel_lines',
    'rev3_min_estimate_kernel_lines',
  ]);
  const measurement: Measurement = {
    main_sha: text(measurementRecord.main_sha, `${source}.measurement.main_sha`, SHA_PATTERN),
    measured_on: text(
      measurementRecord.measured_on,
      `${source}.measurement.measured_on`,
      /^\d{4}-\d{2}-\d{2}$/,
    ),
    merged_kernel_lines: count(
      measurementRecord.merged_kernel_lines,
      `${source}.measurement.merged_kernel_lines`,
    ),
    open_predating_kernel_lines: count(
      measurementRecord.open_predating_kernel_lines,
      `${source}.measurement.open_predating_kernel_lines`,
    ),
    rev3_min_estimate_kernel_lines: count(
      measurementRecord.rev3_min_estimate_kernel_lines,
      `${source}.measurement.rev3_min_estimate_kernel_lines`,
    ),
  };

  if (!Array.isArray(root.predating_prs))
    throw new GateEnvironmentError(`${source}.predating_prs must be an array`);
  const seen = new Set<number>();
  const predating = root.predating_prs.map((value, index): PredatingPr => {
    const where = `${source}.predating_prs[${index}]`;
    const entry = asObject(value, where, [
      'number',
      'branch',
      'head_sha',
      'kernel_added',
      'kernel_deleted',
      'module_delta',
    ]);
    const parsed: PredatingPr = {
      number: count(entry.number, `${where}.number`),
      branch: text(entry.branch, `${where}.branch`),
      head_sha: text(entry.head_sha, `${where}.head_sha`, SHA_PATTERN),
      kernel_added: count(entry.kernel_added, `${where}.kernel_added`),
      kernel_deleted: count(entry.kernel_deleted, `${where}.kernel_deleted`),
      module_delta: count(entry.module_delta, `${where}.module_delta`, true),
    };
    if (seen.has(parsed.number))
      throw new GateEnvironmentError(`${where}.number #${parsed.number} is listed twice`);
    seen.add(parsed.number);
    return parsed;
  });

  return {
    $schema: POLICY_SCHEMA,
    schema_version: 1,
    status: root.status,
    adr_refs: adrRefs,
    base_sha: baseSha,
    base_exception: baseException,
    ceiling: parseLimits(root.ceiling, `${source}.ceiling`, true),
    per_pr_max: parseLimits(root.per_pr_max, `${source}.per_pr_max`, true),
    measurement,
    predating_prs: predating,
  };
}

// ---------------------------------------------------------------------------
// Git measurement
// ---------------------------------------------------------------------------

function git(repoRoot: string, args: readonly string[]): string {
  // `--repo-root` is the repository measured, never the ambient git context:
  // under a hook GIT_DIR / GIT_INDEX_FILE would override `-C` (repoPinnedEnv).
  return execFileSync('git', ['-C', repoRoot, '-c', 'core.quotepath=off', ...args], {
    encoding: 'utf8',
    env: repoPinnedEnv(),
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitSucceeds(repoRoot: string, args: readonly string[]): boolean {
  try {
    git(repoRoot, args);
    return true;
  } catch {
    return false;
  }
}

function resolveCommit(repoRoot: string, rev: string, what: string): string {
  try {
    return git(repoRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).trim();
  } catch {
    throw new GateEnvironmentError(`${what} "${rev}" is not a commit in ${repoRoot}`);
  }
}

/** A path under the kernel package that is not a test. */
export function isKernelSource(path: string): boolean {
  if (!path.startsWith(KERNEL_ROOT)) return false;
  const segments = path.slice(KERNEL_ROOT.length).split('/');
  const base = segments[segments.length - 1] ?? '';
  const directories = segments.slice(0, -1);
  if (directories.some((segment) => segment === 'tests' || segment === 'test')) return false;
  return !(/^test_.*\.py$/.test(base) || /_test\.py$/.test(base) || base === 'conftest.py');
}

function isKernelModule(path: string): boolean {
  return isKernelSource(path) && path.endsWith('.py');
}

interface LineDelta {
  readonly added: number;
  readonly deleted: number;
}

function sumNumstat(lines: readonly string[]): LineDelta {
  let added = 0;
  let deleted = 0;
  for (const line of lines) {
    const [a, d, path] = line.split('\t');
    if (path === undefined || !isKernelSource(path)) continue;
    // Binary files report "-": they carry no lines to charge.
    if (a !== undefined && a !== '-') added += Number(a);
    if (d !== undefined && d !== '-') deleted += Number(d);
  }
  return { added, deleted };
}

/** Gross added minus the deletions that exceed it. */
export function charge(delta: LineDelta): number {
  return delta.added - Math.max(0, delta.deleted - delta.added);
}

interface MergedChange extends LineDelta {
  readonly sha: string;
  readonly subject: string;
  readonly pr: number | null;
}

function prOfSubject(subject: string): number | null {
  const match = MERGE_SUBJECT_PR.exec(subject) ?? SQUASH_SUBJECT_PR.exec(subject);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function mergedChanges(repoRoot: string, base: string, ref: string): MergedChange[] {
  const out = git(repoRoot, [
    'log',
    '--first-parent',
    '--diff-merges=first-parent',
    '--no-renames',
    '--numstat',
    '--format=@@%H%x09%s',
    `${base}..${ref}`,
    '--',
    KERNEL_ROOT,
  ]);
  const changes: MergedChange[] = [];
  let header: { sha: string; subject: string } | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (header === null) return;
    const delta = sumNumstat(body);
    changes.push({ ...header, pr: prOfSubject(header.subject), ...delta });
  };
  for (const line of out.split('\n')) {
    if (line.startsWith('@@')) {
      flush();
      const [sha, ...subject] = line.slice(2).split('\t');
      header = { sha: sha ?? '', subject: subject.join('\t') };
      body = [];
    } else if (line.length > 0) {
      body.push(line);
    }
  }
  flush();
  return changes;
}

function moduleCount(repoRoot: string, rev: string): number {
  return git(repoRoot, ['ls-tree', '-r', '--name-only', rev, '--', KERNEL_ROOT])
    .split('\n')
    .filter((path) => path.length > 0 && isKernelModule(path)).length;
}

function readPolicyAt(repoRoot: string, rev: string): Policy | null {
  if (!gitSucceeds(repoRoot, ['cat-file', '-e', `${rev}:${POLICY_PATH}`])) return null;
  const raw = git(repoRoot, ['show', `${rev}:${POLICY_PATH}`]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new GateEnvironmentError(
      `${POLICY_PATH} at ${rev} is not JSON: ${(error as Error).message}`,
    );
  }
  return parsePolicy(parsed, `${POLICY_PATH}@${rev.slice(0, 12)}`);
}

function changedPaths(repoRoot: string, from: string, to: string): Map<string, string> {
  const out = git(repoRoot, ['diff', '--no-renames', '--name-status', from, to]);
  const paths = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [status, path] = line.split('\t');
    if (status !== undefined && path !== undefined) paths.set(path, status);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Policy change authority
// ---------------------------------------------------------------------------

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as JsonObject;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Lower limits and fewer (unchanged) predating entries; everything else identical. */
function onlyTightens(base: Policy, head: Policy): boolean {
  const rest = (policy: Policy): JsonObject => {
    const { ceiling: _ceiling, per_pr_max: _perPr, predating_prs: _predating, ...others } = policy;
    return others;
  };
  if (canonical(rest(base)) !== canonical(rest(head))) return false;
  if (head.ceiling.kernel_lines > base.ceiling.kernel_lines) return false;
  if (head.ceiling.module_net > base.ceiling.module_net) return false;
  if (head.per_pr_max.kernel_lines > base.per_pr_max.kernel_lines) return false;
  if (head.per_pr_max.module_net > base.per_pr_max.module_net) return false;
  const baseEntries = new Map(base.predating_prs.map((entry) => [entry.number, canonical(entry)]));
  return head.predating_prs.every((entry) => baseEntries.get(entry.number) === canonical(entry));
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

interface Options {
  readonly repoRoot: string;
  readonly head: string;
  readonly baseRef: string;
  readonly prNumber: number | null;
  readonly headRef: string | null;
  readonly json: boolean;
}

interface Violation {
  readonly rule:
    | 'per_change_lines'
    | 'per_change_modules'
    | 'cumulative_lines'
    | 'cumulative_modules'
    | 'policy_change_without_adr';
  readonly message: string;
}

interface Report {
  readonly verdict: 'pass' | 'fail';
  readonly violations: Violation[];
  readonly policy: {
    readonly path: string;
    readonly status: string;
    readonly adr_refs: readonly string[];
    readonly evaluated_from: 'head' | 'base_ref';
    readonly base_sha: string;
    readonly base_exception: BaseException;
  };
  readonly refs: { readonly head: string; readonly base_ref: string; readonly merge_base: string };
  readonly merged: {
    readonly changes: number;
    readonly added: number;
    readonly deleted: number;
    readonly credit: number;
    readonly measure: number;
    readonly modules: number;
  };
  readonly change: {
    readonly added: number;
    readonly deleted: number;
    readonly charge: number;
    readonly modules: number;
    readonly predating_entry: number | null;
    readonly allowance_lines: number;
    readonly allowance_modules: number;
  };
  readonly projected: { readonly lines: number; readonly modules: number };
  readonly limits: {
    readonly ceiling_lines: number;
    readonly ceiling_modules: number;
    readonly per_change_lines: number;
    readonly per_change_modules: number;
  };
  readonly stale_predating: number[];
  readonly merged_over_cap: { pr: number | null; added: number }[];
}

const RAISE_RULE = `Raise a limit only by an ADR in the same PR: edit ${POLICY_PATH} and add or amend an ADR it lists in adr_refs.`;

export function evaluate(options: Options): Report {
  const { repoRoot } = options;
  const head = resolveCommit(repoRoot, options.head, '--head');
  const baseRef = resolveCommit(repoRoot, options.baseRef, '--base-ref');
  const mergeBase = git(repoRoot, ['merge-base', baseRef, head]).trim();
  if (mergeBase.length === 0)
    throw new GateEnvironmentError(`--head and --base-ref share no history`);

  const headPolicy = readPolicyAt(repoRoot, head);
  if (headPolicy === null)
    throw new GateEnvironmentError(`${POLICY_PATH} is missing at ${options.head}`);
  const basePolicy = readPolicyAt(repoRoot, baseRef);
  const changed = changedPaths(repoRoot, mergeBase, head);

  const violations: Violation[] = [];
  let policy = headPolicy;
  let evaluatedFrom: 'head' | 'base_ref' = 'head';
  const policyUnchanged = basePolicy !== null && canonical(basePolicy) === canonical(headPolicy);
  if (!policyUnchanged && !(basePolicy !== null && onlyTightens(basePolicy, headPolicy))) {
    const adrInDiff = headPolicy.adr_refs.filter((ref) => {
      const status = changed.get(ref);
      return status === 'A' || status === 'M';
    });
    if (adrInDiff.length === 0) {
      violations.push({
        rule: 'policy_change_without_adr',
        message:
          `${POLICY_PATH} changes beyond tightening, and this diff adds or modifies none of the ADRs it lists ` +
          `(${headPolicy.adr_refs.join(', ')}). ${RAISE_RULE}`,
      });
      if (basePolicy !== null) {
        policy = basePolicy;
        evaluatedFrom = 'base_ref';
      }
    }
  }

  const base = policy.base_sha;
  if (!gitSucceeds(repoRoot, ['cat-file', '-e', `${base}^{commit}`])) {
    throw new GateEnvironmentError(
      `base_sha ${base} is not a commit in ${repoRoot} (fetch full history)`,
    );
  }
  for (const [rev, name] of [
    [baseRef, '--base-ref'],
    [head, '--head'],
  ] as const) {
    if (!gitSucceeds(repoRoot, ['merge-base', '--is-ancestor', base, rev])) {
      throw new GateEnvironmentError(`base_sha ${base} is not an ancestor of ${name} ${rev}`);
    }
  }

  const merged = mergedChanges(repoRoot, base, baseRef);
  const mergedAdded = merged.reduce((sum, item) => sum + item.added, 0);
  const mergedDeleted = merged.reduce((sum, item) => sum + item.deleted, 0);
  const mergedMeasure = merged.reduce((sum, item) => sum + charge(item), 0);
  const mergedModules = moduleCount(repoRoot, baseRef) - moduleCount(repoRoot, base);

  const delta = sumNumstat(
    git(repoRoot, ['diff', '--no-renames', '--numstat', mergeBase, head, '--', KERNEL_ROOT]).split(
      '\n',
    ),
  );
  const changeCharge = charge(delta);
  const changeModules = moduleCount(repoRoot, head) - moduleCount(repoRoot, mergeBase);

  const mergedPrs = new Set(
    merged.map((item) => item.pr).filter((pr): pr is number => pr !== null),
  );
  const stale = policy.predating_prs
    .filter((entry) => mergedPrs.has(entry.number))
    .map((entry) => entry.number);
  const entry =
    options.prNumber !== null && options.headRef !== null
      ? (policy.predating_prs.find(
          (candidate) =>
            candidate.number === options.prNumber &&
            candidate.branch === options.headRef &&
            !mergedPrs.has(candidate.number),
        ) ?? null)
      : null;

  const allowanceLines = Math.max(policy.per_pr_max.kernel_lines, entry?.kernel_added ?? 0);
  const allowanceModules = Math.max(
    policy.per_pr_max.module_net,
    entry?.module_delta ?? Number.MIN_SAFE_INTEGER,
  );
  const allowanceSource =
    entry === null
      ? 'the per-PR cap'
      : `its allowance (named predating PR #${entry.number}, measured at ${entry.head_sha.slice(0, 9)})`;

  if (delta.added > allowanceLines) {
    violations.push({
      rule: 'per_change_lines',
      message:
        `this change adds ${delta.added} non-test kernel lines under ${KERNEL_ROOT}, over ${allowanceSource} of ` +
        `${allowanceLines}. Split it, or ${RAISE_RULE}`,
    });
  }
  if (changeModules > allowanceModules) {
    violations.push({
      rule: 'per_change_modules',
      message:
        `this change moves the kernel module count by ${changeModules >= 0 ? '+' : ''}${changeModules}, over ` +
        `${allowanceSource} of ${allowanceModules}. Fold the code into an existing module or delete one, or ${RAISE_RULE}`,
    });
  }

  const isPushRun = head === baseRef;
  const projectedLines = mergedMeasure + changeCharge;
  const projectedModules = mergedModules + changeModules;
  if (projectedLines > policy.ceiling.kernel_lines && (changeCharge > 0 || isPushRun)) {
    violations.push({
      rule: 'cumulative_lines',
      message:
        `kernel lines since base ${base.slice(0, 9)} would be ${projectedLines} (merged ${mergedMeasure} + this change ` +
        `${changeCharge}), over the ceiling of ${policy.ceiling.kernel_lines}. ${RAISE_RULE}`,
    });
  }
  if (projectedModules > policy.ceiling.module_net && (changeModules > 0 || isPushRun)) {
    violations.push({
      rule: 'cumulative_modules',
      message:
        `kernel modules since base ${base.slice(0, 9)} would be ${projectedModules >= 0 ? '+' : ''}${projectedModules} ` +
        `(merged ${mergedModules} + this change ${changeModules}), over the ceiling of ${policy.ceiling.module_net}. ${RAISE_RULE}`,
    });
  }

  return {
    verdict: violations.length === 0 ? 'pass' : 'fail',
    violations,
    policy: {
      path: POLICY_PATH,
      status: policy.status,
      adr_refs: policy.adr_refs,
      evaluated_from: evaluatedFrom,
      base_sha: base,
      base_exception: policy.base_exception,
    },
    refs: { head, base_ref: baseRef, merge_base: mergeBase },
    merged: {
      changes: merged.length,
      added: mergedAdded,
      deleted: mergedDeleted,
      credit: mergedAdded - mergedMeasure,
      measure: mergedMeasure,
      modules: mergedModules,
    },
    change: {
      added: delta.added,
      deleted: delta.deleted,
      charge: changeCharge,
      modules: changeModules,
      predating_entry: entry?.number ?? null,
      allowance_lines: allowanceLines,
      allowance_modules: allowanceModules,
    },
    projected: { lines: projectedLines, modules: projectedModules },
    limits: {
      ceiling_lines: policy.ceiling.kernel_lines,
      ceiling_modules: policy.ceiling.module_net,
      per_change_lines: policy.per_pr_max.kernel_lines,
      per_change_modules: policy.per_pr_max.module_net,
    },
    stale_predating: stale,
    merged_over_cap: merged
      .filter((item) => item.added > policy.per_pr_max.kernel_lines)
      .map((item) => ({ pr: item.pr, added: item.added })),
  };
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function renderText(report: Report): string {
  const short = (sha: string): string => sha.slice(0, 9);
  const out = [
    `kernel-budget: ${report.policy.path} (status ${report.policy.status}; ${report.policy.adr_refs.join(', ')})` +
      (report.policy.evaluated_from === 'base_ref'
        ? ' [limits from the base ref: the head policy is not authorised]'
        : ''),
    `  base         ${short(report.policy.base_sha)} = PR #${report.policy.base_exception.pr} merge; its ` +
      `+${report.policy.base_exception.kernel_added}/-${report.policy.base_exception.kernel_deleted} kernel lines are the recorded pre-program exception`,
    `  merged       ${report.merged.changes} change(s) to ${short(report.refs.base_ref)}: +${report.merged.added}/-${report.merged.deleted}, ` +
      `credit ${report.merged.credit}, measure ${report.merged.measure}; modules ${signed(report.merged.modules)}`,
    `  this change  ${short(report.refs.merge_base)}..${short(report.refs.head)}: +${report.change.added}/-${report.change.deleted}, ` +
      `charge ${report.change.charge}; modules ${signed(report.change.modules)}` +
      (report.change.predating_entry === null
        ? ''
        : ` (named predating PR #${report.change.predating_entry})`),
    `  projected    ${report.projected.lines} / ceiling ${report.limits.ceiling_lines} lines; modules ` +
      `${signed(report.projected.modules)} / ceiling ${signed(report.limits.ceiling_modules)}`,
    `  per change   +${report.change.allowance_lines} lines, ${signed(report.change.allowance_modules)} modules allowed ` +
      `(cap ${report.limits.per_change_lines} / ${signed(report.limits.per_change_modules)})`,
  ];
  if (report.merged_over_cap.length > 0) {
    out.push(
      `  merged over the per-change cap: ${report.merged_over_cap
        .map((item) => `${item.pr === null ? '(no PR)' : `#${item.pr}`} +${item.added}`)
        .join(', ')}`,
    );
  }
  if (report.stale_predating.length > 0) {
    out.push(
      `  stale predating entries (merged; remove from the policy): ${report.stale_predating.map((pr) => `#${pr}`).join(', ')}`,
    );
  }
  for (const violation of report.violations)
    out.push(`  FAIL ${violation.rule}: ${violation.message}`);
  out.push(`  verdict: ${report.verdict.toUpperCase()}`);
  return `${out.join('\n')}\n`;
}

function parseArgs(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (!['--repo-root', '--head', '--base-ref', '--pr-number', '--head-ref'].includes(flag)) {
      throw new GateEnvironmentError(`unknown argument ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new GateEnvironmentError(`${flag} needs a value`);
    values.set(flag, value);
    index += 1;
  }
  // CI passes `--pr-number "" --head-ref ""` on push runs: empty means absent.
  const prText = values.get('--pr-number') ?? '';
  if (prText !== '' && !/^\d+$/.test(prText))
    throw new GateEnvironmentError(`--pr-number must be a number`);
  const headRef = values.get('--head-ref') ?? '';
  return {
    repoRoot: resolve(values.get('--repo-root') ?? process.cwd()),
    head: values.get('--head') || 'HEAD',
    baseRef: values.get('--base-ref') || 'origin/main',
    prNumber: prText === '' ? null : Number(prText),
    headRef: headRef === '' ? null : headRef,
    json,
  };
}

function main(): void {
  let report: Report;
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
    report = evaluate(options);
  } catch (error) {
    if (error instanceof GateEnvironmentError) {
      process.stderr.write(`kernel-budget: ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    for (const violation of report.violations) {
      process.stderr.write(`kernel-budget: FAIL ${violation.rule}: ${violation.message}\n`);
    }
  } else {
    process.stdout.write(renderText(report));
  }
  process.exit(report.verdict === 'pass' ? 0 : 1);
}

if (require.main === module) main();
