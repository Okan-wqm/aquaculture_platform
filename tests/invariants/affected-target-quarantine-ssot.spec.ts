/**
 * Platform-wide invariant — affected-lane quarantine is TRACKED debt:
 *
 * `scripts/ci/affected-target-policy.json` lets the affected CI lane run a
 * target as a warning instead of a gate for the projects it names. Every such
 * entry is a test (or lint) the PR gate does not enforce, and CLAUDE.md allows
 * exactly one shape for that: an owner, a deadline and a tracked finding.
 *
 * # WHY
 *
 * Until 2026-09-04 the `test` map held 19 bare strings — "CI run 26116890061:
 * existing unit-test debt" — for farm-service, sensor-service, auth-service,
 * admin-api-service and fourteen more. No owner, no clock, no finding, one
 * key naming a project that no longer existed. ci-full, the lane that used to
 * run those suites regardless, stopped running on pull requests, so the
 * quarantine silently became the whole story for those projects
 * (PROC-MEDIUM-025). lint-quarantine-ssot.spec.ts guarded the lint exclusion
 * file's reasons and ceiling; nothing guarded this file.
 *
 * # WHAT
 *
 * The entry shape is the one tests/invariants/invariant-reachability.dormant.json
 * already uses — `{ owner, reason, expires_on, finding_id }` — for EVERY
 * target, so there is one vocabulary for "a gate we are not running yet".
 * scripts/ci/write-affected-target-report.mjs refuses the file when an entry
 * is malformed or a key repeats (scripts/ci/lib/strict-json.mjs), and gates
 * the project of an entry past its expiry strictly
 * (scripts/ci/lib/affected-target-policy.mjs: the lane fails closed for that
 * project, never for every lane); this spec locks the file's contents, proves
 * both behaviourally, replays the live file past every expiry it names, keeps
 * every finding id real and unresolved, keeps every key a real Nx project,
 * and ratchets the `test` quarantine count downward.
 *
 * # THE LINT QUARANTINE IS A MEASURED ONE (HL-lint-quarantine, 2026-10-16)
 *
 * The 40 `lint` entries all expired on 2026-10-31, one date chosen without a
 * measurement and owned by the operator, and the writer then refused the WHOLE
 * file once one entry was past its date: from 2026-11-01 every affected lane
 * would have failed on every PR and main push (INFRA-MEDIUM-222). A lapsed
 * entry now quarantines nothing, so no date in this file can take a lane
 * down, and this spec no longer fails on a calendar day. Each lint entry carries a
 * committed measurement (scripts/ci/lint-debt-measurement.json, written by
 * scripts/ci/lint-debt-measure.mjs), its expiry is at most the bound computed
 * from that measurement by the same exported function renewal uses, the
 * measurement is anchored on a commit in HEAD's history, a project that
 * measured clean is not in the quarantine, a project with security-class lint
 * (getRepository, JWT_SECRET, the aquaculture tenant/SSRF/XSS rules) is never
 * renewed, and the lint count is ratcheted downward like the test count.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { projectRegistry } from '../../tools/gates/finding-registry-projection';
import { ORPHAN_MD_HEADING_REGEX } from '../../tools/gates/finding-registry-store';
import { callEsmExport, esmExportResult } from './helpers/esm-export';
import { nxProjectRoot, nxProjects } from './helpers/nx';

import { removeFixtureTree } from '../../tools/gates/fixture-tree';
const REPO_ROOT = resolve(__dirname, '..', '..');
const POLICY_PATH = join(REPO_ROOT, 'scripts/ci/affected-target-policy.json');
const WRITER_PATH = join(REPO_ROOT, 'scripts/ci/write-affected-target-report.mjs');
const POLICY_LIB = join(REPO_ROOT, 'scripts/ci/lib/affected-target-policy.mjs');
const MEASURE_PATH = join(REPO_ROOT, 'scripts/ci/lint-debt-measure.mjs');
const LINT_DEBT_LIB = join(REPO_ROOT, 'scripts/ci/lib/lint-debt.mjs');
const ESLINT_CONFIG = join(REPO_ROOT, 'eslint.config.mjs');
const ORPHAN_MD_PATH = join(REPO_ROOT, 'docs/reviews/orphan-findings.md');

/**
 * Ratchet: the number of projects whose `test` target the affected lane does
 * NOT gate. Lower it when a key is deleted; never raise it. Measured
 * 2026-09-04 by running all 18 quarantined suites: every one was green, so
 * the map emptied and this ceiling is zero (PROC-MEDIUM-025).
 */
const MAX_TEST_QUARANTINE = 0;

/**
 * Ratchet: the number of projects whose `lint` target the affected lane does
 * NOT gate. Lower it when a key is deleted; never raise it. Measured
 * 2026-10-16 (scripts/ci/lint-debt-measurement.json): 36 of the 40 entries
 * linted clean and left the quarantine; backend-common, event-bus, outbox and
 * storage carry debt-class errors under ORPHAN-HIGH-588.
 */
const MAX_LINT_QUARANTINE = 4;

/** Targets whose quarantine map stays empty: see 'never quarantines the integration or contract lane'. */
const NEVER_QUARANTINED_TARGETS = ['test:integration', 'test:contract'] as const;

interface QuarantineEntry {
  readonly owner: string;
  readonly reason: string;
  readonly expires_on: string;
  readonly finding_id: string;
}

interface Policy {
  readonly version: number;
  readonly targets: Record<string, { readonly knownUnstableProjects: Record<string, unknown> }>;
}

function readPolicy(): Policy {
  return JSON.parse(readFileSync(POLICY_PATH, 'utf8')) as Policy;
}

function entries(): ReadonlyArray<{ target: string; project: string; entry: unknown }> {
  const out: { target: string; project: string; entry: unknown }[] = [];
  for (const [target, config] of Object.entries(readPolicy().targets)) {
    for (const [project, entry] of Object.entries(config.knownUnstableProjects)) {
      out.push({ target, project, entry });
    }
  }
  return out;
}

/**
 * A TypeScript narrowing, not a rule: the four fields are strings. Whether
 * an entry is well formed (owner, reason length, date, registry-shaped id)
 * is decided by scripts/ci/lib/reviewed-exception.mjs through the writer,
 * which the first test below runs over the committed file for every target.
 * This spec used to restate those rules here (INFRA-LOW-229).
 */
function isEntry(value: unknown): value is QuarantineEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'owner' in value &&
    typeof value.owner === 'string' &&
    'reason' in value &&
    typeof value.reason === 'string' &&
    'expires_on' in value &&
    typeof value.expires_on === 'string' &&
    'finding_id' in value &&
    typeof value.finding_id === 'string'
  );
}

/**
 * Finding ids that still represent open debt: registry rows the projection
 * does not resolve, or orphan-store headings. The projection, not the stored
 * `state`: a merged `Closes:` trailer resolves a finding the moment it merges
 * and no workflow refreshes the stored copy (MF-1, PROC-HIGH-039), so the
 * stored state would keep a quarantine alive past its closed finding.
 */
function unresolvedFindingIds(): Set<string> {
  const ids = new Set<string>();
  for (const row of projectRegistry(REPO_ROOT)) {
    if (row.state !== 'RESOLVED') ids.add(row.id);
  }
  for (const line of readFileSync(ORPHAN_MD_PATH, 'utf8').split('\n')) {
    const match = ORPHAN_MD_HEADING_REGEX.exec(line);
    if (match?.[1] && !/—\s*RESOLVED\b/.test(line)) ids.add(match[1]);
  }
  return ids;
}

interface WriterOutcome {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The strict project list the writer produced; empty when it refused. */
  readonly strict: readonly string[];
}

function runWriter(policy: unknown, target = 'test'): WriterOutcome {
  return runWriterText(JSON.stringify(policy), target);
}

/** The writer over policy TEXT, so a fixture can carry what JSON.stringify cannot (a duplicated key). */
function runWriterText(policyText: string, target: string): WriterOutcome {
  const dir = mkdtempSync(join(tmpdir(), 'affected-policy-'));
  try {
    const policyPath = join(dir, 'policy.json');
    writeFileSync(policyPath, policyText);
    const affected = join(dir, 'affected.txt');
    writeFileSync(affected, 'invariants\n');
    const empty = join(dir, 'empty.txt');
    writeFileSync(empty, '');
    const strictPath = join(dir, 'strict.txt');
    const strict = (): readonly string[] =>
      existsSync(strictPath) ? readFileSync(strictPath, 'utf8').split('\n').filter(Boolean) : [];
    try {
      const stdout = execFileSync(
        'node',
        [
          WRITER_PATH,
          '--target',
          target,
          '--base',
          'base',
          '--head',
          'head',
          '--policy',
          policyPath,
          '--changed-files',
          empty,
          '--affected-projects',
          affected,
          '--explicit-excludes',
          empty,
          '--strict-projects',
          strictPath,
          '--report',
          join(dir, 'report.json'),
          '--dry-run',
          'true',
        ],
        { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return { status: 0, stdout, stderr: '', strict: strict() };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return {
        status: failure.status ?? 1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
        strict: strict(),
      };
    }
  } finally {
    removeFixtureTree(dir);
  }
}

const validEntry: QuarantineEntry = {
  owner: '@someone',
  reason: 'a reason that is long enough to explain the quarantine',
  expires_on: '2999-01-01',
  finding_id: 'INFRA-LOW-001',
};

function policyWith(entry: unknown): unknown {
  return { version: 2, targets: { test: { knownUnstableProjects: { invariants: entry } } } };
}

interface ProcessOutcome {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runNode(args: readonly string[]): ProcessOutcome {
  try {
    const stdout = execFileSync('node', [...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

/**
 * `lint-debt-measure.mjs --verify` over the live files, or over a fixture
 * policy and measurement (`null` measurement: no measurement file at all).
 */
function runLintVerify(fixture?: {
  readonly policy: unknown;
  readonly measurement: unknown;
}): ProcessOutcome {
  if (fixture === undefined) return runNode([MEASURE_PATH, '--verify']);
  return runLintVerifyText(JSON.stringify(fixture.policy), fixture.measurement);
}

/** `--verify` over policy TEXT, so a fixture can carry a duplicated key. */
function runLintVerifyText(policyText: string, measurement: unknown): ProcessOutcome {
  const dir = mkdtempSync(join(tmpdir(), 'lint-debt-verify-'));
  try {
    const policyPath = join(dir, 'policy.json');
    const measurementPath = join(dir, 'measurement.json');
    writeFileSync(policyPath, policyText);
    if (measurement !== null) {
      writeFileSync(measurementPath, JSON.stringify(measurement));
    }
    return runNode([
      MEASURE_PATH,
      '--verify',
      '--policy',
      policyPath,
      '--measurement',
      measurementPath,
    ]);
  } finally {
    removeFixtureTree(dir);
  }
}

/**
 * Call one export of scripts/ci/lib/lint-debt.mjs, the module renewal and
 * verification both use, so these expectations pin THE function rather than
 * a copy of its arithmetic.
 */
function callLintDebt(name: string, ...args: readonly unknown[]): ProcessOutcome {
  return callEsmExport(LINT_DEBT_LIB, name, args);
}

function lintDebt<T>(name: string, ...args: readonly unknown[]): T {
  return esmExportResult<T>(LINT_DEBT_LIB, name, args);
}

interface Partition {
  readonly strictProjects: readonly string[];
  readonly explicitlyExcludedProjects: readonly string[];
  readonly quarantinedProjects: ReadonlyArray<{ readonly project: string }>;
  readonly expiredQuarantineProjects: ReadonlyArray<{ readonly project: string }>;
}

/** The writer's own partition (scripts/ci/lib/affected-target-policy.mjs) on a chosen day. */
function partitionOn(
  policy: unknown,
  target: string,
  affected: readonly string[],
  today: string,
): Partition {
  return esmExportResult<Partition>(POLICY_LIB, 'partitionAffectedProjects', [
    policy,
    { target, affectedProjects: affected, explicitExcludes: [], today },
  ]);
}

const HEAD_SHA = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
}).trim();

/** The UTC day HEAD was committed: the earliest day a measurement of HEAD can carry. */
const HEAD_DAY = new Date(
  Number(
    execFileSync('git', ['show', '-s', '--format=%ct', HEAD_SHA], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim(),
  ) * 1000,
)
  .toISOString()
  .slice(0, 10);

function lintPolicyWith(entry: unknown): unknown {
  return { version: 2, targets: { lint: { knownUnstableProjects: { invariants: entry } } } };
}

function lintMeasurementOf(
  measured: unknown,
  sha: string = HEAD_SHA,
  measuredAt: string = HEAD_DAY,
): unknown {
  return {
    schema: 'aqua.lint-debt-measurement.v1',
    measured_at: measuredAt,
    measured_sha: sha,
    projects: measured === undefined ? {} : { invariants: measured },
  };
}

/** 26 blocking problems: the bound is the measured day + 14 d + 2 × 7 d. */
const DEBT_26 = { debt: 26, security: 0, security_rules: {} };
const lintEntry = (expiresOn: string): QuarantineEntry => ({
  ...validEntry,
  owner: 'claude',
  expires_on: expiresOn,
});

describe('affected-lane quarantine is tracked debt', () => {
  it('is on the structured-entry policy version', () => {
    expect(readPolicy().version).toBe(2);
  });

  it('the writer accepts the committed policy for every target it names', () => {
    // The one whole-file detector. Every lane's writer reads this file and
    // refuses it whole when it repeats a key or when any entry of any target
    // lacks an owner, a reason, an expiry or a finding — through
    // reviewed-exception.mjs, the one statement of those rules — so running
    // it over the committed bytes, once per target a lane drives, proves
    // every entry well formed and every lane able to read the file.
    const committed = readFileSync(POLICY_PATH, 'utf8');
    const refused = Object.keys(readPolicy().targets)
      .map((target) => ({ target, result: runWriterText(committed, target) }))
      .filter(({ result }) => result.status !== 0)
      .map(({ target, result }) => `${target}: ${result.stderr.trim()}`);
    expect(refused).toEqual([]);
  });

  it('survives every expiry it names: replayed past each date, the writer accepts the file and gates each lapsed project strictly', () => {
    // An entry is expired the day after the date it names (ISO strings sort
    // lexicographically, so no timezone reasoning is needed). The replay uses
    // the writer's own partition over the live file, so a date in this file
    // can never again refuse the policy for every affected lane.
    const policy = readPolicy();
    const replays: string[] = [];
    for (const [target, config] of Object.entries(policy.targets)) {
      const quarantine = Object.entries(config.knownUnstableProjects).filter(
        (pair): pair is [string, QuarantineEntry] => isEntry(pair[1]),
      );
      const projects = quarantine.map(([project]) => project).sort();
      const dates = [...new Set(quarantine.map(([, entry]) => entry.expires_on))].sort();
      for (const date of dates) {
        const dayAfter = lintDebt<string>('addDaysIso', date, 1);
        const lapsed = quarantine
          .filter(([, entry]) => entry.expires_on < dayAfter)
          .map(([project]) => project)
          .sort();
        const partition = partitionOn(policy, target, projects, dayAfter);
        expect([...partition.strictProjects].sort()).toEqual(lapsed);
        expect(partition.expiredQuarantineProjects.map(({ project }) => project).sort()).toEqual(
          lapsed,
        );
        expect(partition.quarantinedProjects.map(({ project }) => project).sort()).toEqual(
          projects.filter((project) => !lapsed.includes(project)),
        );
        replays.push(`${target}@${dayAfter}`);
      }
    }
    // The replay is not vacuous while the lint quarantine still has entries.
    expect(replays.length).toBeGreaterThan(0);
  });

  it('points every entry at a finding that still exists and is not resolved', () => {
    const open = unresolvedFindingIds();
    const dangling = entries()
      .filter(({ entry }) => isEntry(entry) && !open.has(entry.finding_id))
      .map(
        ({ target, project, entry }) =>
          `${target}/${project} -> ${(entry as QuarantineEntry).finding_id}`,
      );
    expect(dangling).toEqual([]);
  });

  it('names only projects that exist in the workspace', () => {
    const workspace = new Set(nxProjects());
    const vanished = entries()
      .filter(({ project }) => !workspace.has(project))
      .map(({ target, project }) => `${target}/${project}`);
    expect(vanished).toEqual([]);
  });

  it('ratchets the test quarantine downward', () => {
    const count = Object.keys(readPolicy().targets['test']?.knownUnstableProjects ?? {}).length;
    expect(count).toBeLessThanOrEqual(MAX_TEST_QUARANTINE);
  });

  it('never quarantines the integration or contract lane', () => {
    // test:integration is the lane that runs the farm-service and auth-service
    // Testcontainers suites (INFRA-MEDIUM-158); a quarantine entry there turns
    // a service's database tests into a warning, the dead-lane condition the
    // lane was wired to end (FARM-MEDIUM-301). test:contract is the admin
    // route contract's hard gate. A failing suite is fixed, never quarantined.
    const { targets } = readPolicy();
    const quarantined = NEVER_QUARANTINED_TARGETS.map((target) => {
      const config = targets[target];
      if (config === undefined) return `${target}: missing from the policy`;
      const projects = Object.keys(config.knownUnstableProjects);
      return projects.length === 0 ? null : `${target}: ${projects.join(', ')}`;
    }).filter((problem): problem is string => problem !== null);
    expect(quarantined).toEqual([]);
  });

  describe('the report writer refuses a policy it cannot trust', () => {
    it('accepts a well-formed, unexpired entry and does not gate its project', () => {
      const result = runWriter(policyWith(validEntry));
      expect(result.status).toBe(0);
      expect(result.strict).toEqual([]);
    });

    it('refuses a bare reason string', () => {
      const result = runWriter(policyWith('CI run 26116890061: existing unit-test debt.'));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('entry must be an object');
    });

    it('gates the project of an expired entry strictly and still accepts the file', () => {
      const unexpired = { ...validEntry, expires_on: '2999-01-01' };
      const result = runWriter({
        version: 2,
        targets: {
          test: {
            knownUnstableProjects: {
              invariants: { ...validEntry, expires_on: '2020-01-01' },
              'still-quarantined': unexpired,
            },
          },
          lint: { knownUnstableProjects: { elsewhere: unexpired } },
        },
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.strict).toEqual(['invariants']);
      expect(result.stdout).toContain('invariants: expired 2020-01-01');
    });

    it('refuses an entry without a finding', () => {
      const result = runWriter(policyWith({ ...validEntry, finding_id: 'later' }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('finding_id');
    });

    it('refuses the previous policy version outright', () => {
      const result = runWriter({ version: 1, targets: {} });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('version 1 is not 2');
    });

    it('refuses a policy with a duplicated key instead of keeping the last block', () => {
      // JSON.parse keeps the last of two equal keys and drops the first block
      // without a word: here the first `test` block's quarantine would vanish
      // and a reviewer reading the file would see it in force (INFRA-MEDIUM-228).
      const text =
        `{"version":2,"targets":{"test":{"knownUnstableProjects":` +
        `{"invariants":${JSON.stringify(validEntry)}}},"test":{"knownUnstableProjects":{}}}}`;
      const result = runWriterText(text, 'test');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('duplicate key(s) $.targets.test');
    });
  });
});

describe('the lint quarantine is a measured one', () => {
  it('measures every lint entry, keeps each within its bound and anchors the measurement in this history', () => {
    const result = runLintVerify();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('keeps changed-file lint on inside every lint-quarantined project: no baseline entry lies in one', () => {
    // A quarantine relaxes a project's PRE-EXISTING lint debt only. The lint
    // job still runs scripts/ci/lint-changed-files.mjs first, which lints
    // every changed .ts/.tsx file at base and head and fails on a new error,
    // so a getRepository call or JWT_SECRET read added to a quarantined
    // project is caught there. A file in its baseline is skipped by that
    // lint, and inside a quarantined project no other lane lints it
    // (INFRA-MEDIUM-224: create-service-app.ts, the bootstrap every service
    // runs). Same parse as readBaseline() in lint-changed-files.mjs.
    const baseline = readFileSync(
      join(REPO_ROOT, 'scripts/ci/lint-changed-files-baseline.txt'),
      'utf8',
    )
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    const lint = readPolicy().targets['lint'];
    if (lint === undefined) throw new Error('affected-target-policy.json has no lint target');
    const roots = Object.keys(lint.knownUnstableProjects).map((project) => ({
      project,
      root: nxProjectRoot(project),
    }));
    const hidden = baseline.flatMap((file) =>
      roots
        .filter(({ root }) => file.startsWith(`${root}/`))
        .map(({ project }) => `${file} (lint-quarantined ${project})`),
    );
    expect(hidden).toEqual([]);
  });

  it('ratchets the lint quarantine downward', () => {
    const count = Object.keys(readPolicy().targets['lint']?.knownUnstableProjects ?? {}).length;
    expect(count).toBeLessThanOrEqual(MAX_LINT_QUARANTINE);
  });

  it('keeps the policy, its measurement and the rules that renew it owner-reviewed', () => {
    // An agent renewal keeps lint exemptions alive with no person deciding.
    // What these lines enforce: ARIA's risk policy puts a CODEOWNERS path in
    // its human-merge lane (L3), so no ARIA lane merges a change to them.
    // GitHub itself requires no code-owner review on main
    // (required_pull_request_reviews is null, checked 2026-10-16), so another
    // agent session with merge authority is not stopped by them; requiring
    // server-side review is the operator's open decision (HL safety review
    // 2026-10-16, cross-cutting X1 / PRE-1).
    const owned = new Set(
      readFileSync(join(REPO_ROOT, '.github/CODEOWNERS'), 'utf8')
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter(([path, owner]) => path !== undefined && owner === '@Okan-wqm')
        .map(([path]) => path),
    );
    // Every module on the policy's read path is listed: the writer, the
    // partition, the reviewed-exception rules and the strict reader whose
    // value the writer applies and a renewal rewrites the file from.
    const unowned = [
      'scripts/ci/affected-target-policy.json',
      'scripts/ci/write-affected-target-report.mjs',
      'scripts/ci/lib/affected-target-policy.mjs',
      'scripts/ci/lib/reviewed-exception.mjs',
      'scripts/ci/lib/strict-json.mjs',
      'scripts/ci/lint-debt-measurement.json',
      'scripts/ci/lint-debt-measure.mjs',
      'scripts/ci/lib/lint-debt.mjs',
      'eslint.config.mjs',
    ].filter((path) => !owned.has(path));
    expect(unowned).toEqual([]);
  });

  it('bounds an expiry by the measured debt: 14 days plus 7 per 25 problems, at most 90', () => {
    expect(lintDebt('lintQuarantineExpiryBound', '2026-10-16', 1)).toBe('2026-11-06');
    expect(lintDebt('lintQuarantineExpiryBound', '2026-10-16', 25)).toBe('2026-11-06');
    expect(lintDebt('lintQuarantineExpiryBound', '2026-10-16', 26)).toBe('2026-11-13');
    expect(lintDebt('lintQuarantineExpiryBound', '2026-10-16', 100_000)).toBe('2027-01-14');
    expect(callLintDebt('lintQuarantineExpiryBound', '2026-10-16', 0).status).not.toBe(0);
  });

  describe('verification refuses a quarantine it cannot trust', () => {
    const bound26 = lintDebt<string>('lintQuarantineExpiryBound', HEAD_DAY, 26);
    const pastBound26 = lintDebt<string>('addDaysIso', bound26, 1);
    /** Two `lint` blocks: JSON.parse would keep the empty second one and drop the entry. */
    const duplicatedLintPolicy =
      `{"version":2,"targets":{"lint":{"knownUnstableProjects":` +
      `{"invariants":${JSON.stringify(lintEntry(bound26))}}},"lint":{"knownUnstableProjects":{}}}}`;

    it('accepts an expiry on the measured bound', () => {
      const result = runLintVerify({
        policy: lintPolicyWith(lintEntry(bound26)),
        measurement: lintMeasurementOf(DEBT_26),
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    });

    it('refuses an expiry one day past the measured bound', () => {
      const result = runLintVerify({
        policy: lintPolicyWith(lintEntry(pastBound26)),
        measurement: lintMeasurementOf(DEBT_26),
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`expires ${pastBound26}, after ${bound26}`);
    });

    it('refuses a measurement dated after today, which would move every bound', () => {
      const result = runLintVerify({
        policy: lintPolicyWith(lintEntry('2999-03-01')),
        measurement: lintMeasurementOf(DEBT_26, HEAD_SHA, '2999-01-01'),
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('measured_at 2999-01-01 is after today');
    });

    it('refuses a measurement dated before the commit it names', () => {
      const result = runLintVerify({
        policy: lintPolicyWith(lintEntry('2000-01-20')),
        measurement: lintMeasurementOf(DEBT_26, HEAD_SHA, '2000-01-01'),
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `measured_at 2000-01-01 is before ${HEAD_DAY}, the commit date of measured_sha`,
      );
    });

    it('refuses a lint entry that has no measurement', () => {
      const result = runLintVerify({
        policy: lintPolicyWith(lintEntry('2026-10-31')),
        measurement: lintMeasurementOf(undefined),
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('lint/invariants: has no measurement');
    });

    it('refuses lint entries when no measurement file exists', () => {
      const result = runLintVerify({
        policy: lintPolicyWith(lintEntry('2026-10-31')),
        measurement: null,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('1 lint quarantine entries have no measurement');
    });

    it('never renews security-class lint, whatever the expiry', () => {
      const result = runLintVerify({
        policy: lintPolicyWith(lintEntry('2026-10-17')),
        measurement: lintMeasurementOf({
          debt: 26,
          security: 3,
          security_rules: { 'no-restricted-syntax': 3 },
        }),
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('3 security-class lint problems (no-restricted-syntax)');
    });

    it('refuses an entry whose project measured clean', () => {
      const result = runLintVerify({
        policy: lintPolicyWith(lintEntry('2026-10-31')),
        measurement: lintMeasurementOf({ debt: 0, security: 0, security_rules: {} }),
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('measured clean; delete the entry');
    });

    it('refuses a policy with a duplicated key in verification', () => {
      const result = runLintVerifyText(duplicatedLintPolicy, lintMeasurementOf(DEBT_26));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('duplicate key(s) $.targets.lint');
    });

    it('refuses a policy with a duplicated key before it measures, so a renewal cannot rewrite it without its first block', () => {
      // --renew measures first and rewrites the policy from what it parsed.
      // The measurement reads the policy strictly before any eslint or Nx
      // work; --dry-run takes the same path without the clean-tree check.
      const dir = mkdtempSync(join(tmpdir(), 'lint-debt-measure-'));
      try {
        const policyPath = join(dir, 'policy.json');
        writeFileSync(policyPath, duplicatedLintPolicy);
        const result = runNode([MEASURE_PATH, '--dry-run', '--policy', policyPath]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('duplicate key(s) $.targets.lint');
      } finally {
        removeFixtureTree(dir);
      }
    });

    it('refuses a measurement taken on a commit outside this history', () => {
      const result = runLintVerify({
        policy: lintPolicyWith(lintEntry(bound26)),
        measurement: lintMeasurementOf(DEBT_26, 'f'.repeat(40)),
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('is not an ancestor of HEAD');
      // A squash or rebase merge drops the measured commit; the message names the way out.
      expect(result.stderr).toContain('node scripts/ci/lint-debt-measure.mjs --renew');
    });
  });

  it('renews from a measurement: clean entries leave, security-class entries stay as they were, the rest get the bound', () => {
    const before = lintEntry('2026-10-31');
    const renewal = lintDebt<{
      policy: { targets: { lint: { knownUnstableProjects: Record<string, QuarantineEntry> } } };
      deleted: string[];
      renewed: string[];
      refused: string[];
      unmeasured: string[];
    }>(
      'renewLintQuarantine',
      {
        version: 2,
        targets: {
          lint: { knownUnstableProjects: { clean: before, risky: before, owed: before } },
        },
      },
      {
        schema: 'aqua.lint-debt-measurement.v1',
        measured_at: '2026-10-16',
        measured_sha: HEAD_SHA,
        projects: {
          clean: { debt: 0, security: 0 },
          risky: { debt: 26, security: 1 },
          owed: { debt: 26, security: 0 },
        },
      },
    );
    expect(renewal.deleted).toEqual(['clean']);
    expect(renewal.refused).toEqual(['risky']);
    expect(renewal.renewed).toEqual(['owed']);
    expect(renewal.unmeasured).toEqual([]);
    const lint = renewal.policy.targets.lint.knownUnstableProjects;
    expect(Object.keys(lint).sort()).toEqual(['owed', 'risky']);
    expect(lint['risky']).toEqual(before);
    expect(lint['owed']).toEqual({
      owner: 'claude',
      reason: `26 blocking eslint problems measured 2026-10-16 at ${HEAD_SHA.slice(0, 12)}; paid down per project under INFRA-LOW-001.`,
      expires_on: '2026-11-13',
      finding_id: 'INFRA-LOW-001',
    });
  });

  it('lists only the JSON.stringify indent selector as non-security restricted syntax', () => {
    // eslint.config.mjs names the selector instead of picking it by array
    // position; this pins that the list a renewal trusts as non-security is
    // exactly that selector and never a tenant or JWT one.
    const listed = {
      selectors: esmExportResult<ReadonlyArray<{ selector: string; message: string }>>(
        ESLINT_CONFIG,
        'NON_SECURITY_RESTRICTED_SYNTAX',
        [],
      ),
      messages: esmExportResult<readonly string[]>(
        ESLINT_CONFIG,
        'NON_SECURITY_RESTRICTED_SYNTAX_MESSAGES',
        [],
      ),
    };
    expect(listed.selectors.map(({ selector }) => selector)).toEqual([
      "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'][arguments.length>2]",
    ]);
    expect(listed.messages).toEqual(listed.selectors.map(({ message }) => message));
    expect(listed.messages.filter((message) => /getRepository|JWT_SECRET/.test(message))).toEqual(
      [],
    );
  });

  it('counts unknown restricted-syntax messages, unknown plugin rules and unparsed files as security-class', () => {
    const allowed = ['not a security selector'];
    const isSecurity = (message: unknown): boolean =>
      lintDebt<boolean>('isSecurityClassMessage', message, allowed);
    expect(
      isSecurity({ ruleId: 'no-restricted-syntax', message: 'a tenant-isolation selector' }),
    ).toBe(true);
    expect(isSecurity({ ruleId: 'no-restricted-syntax', message: 'not a security selector' })).toBe(
      false,
    );
    expect(isSecurity({ ruleId: 'aquaculture/a-rule-added-tomorrow' })).toBe(true);
    expect(isSecurity({ ruleId: 'aquaculture/no-unverified-tenant-param' })).toBe(true);
    expect(isSecurity({ ruleId: 'aquaculture/no-direct-event-publish' })).toBe(false);
    expect(isSecurity({ ruleId: '@typescript-eslint/no-implied-eval' })).toBe(true);
    expect(isSecurity({ ruleId: 'import/order' })).toBe(false);
    expect(isSecurity({ ruleId: null, fatal: true })).toBe(true);
    expect(isSecurity({ ruleId: null })).toBe(false);
  });

  it('counts every warning of a run past its --max-warnings as debt, and no warning of a run within it', () => {
    const messages = [
      { severity: 1, ruleId: 'import/order' },
      { severity: 1, ruleId: 'import/order' },
      { severity: 2, ruleId: 'no-console' },
    ];
    const gated = lintDebt<{ debt: number; rules: Record<string, number> }>(
      'summarizeLintInvocations',
      [{ results: [{ messages }], maxWarnings: 0 }],
      [],
    );
    expect(gated.debt).toBe(3);
    expect(gated.rules).toEqual({ 'import/order': 2, 'no-console': 1 });
    const ungated = lintDebt<{ debt: number; rules: Record<string, number> }>(
      'summarizeLintInvocations',
      [{ results: [{ messages }], maxWarnings: null }],
      [],
    );
    expect(ungated.debt).toBe(1);
    expect(ungated.rules).toEqual({ 'no-console': 1 });
    // Past a limit above zero every warning of the run blocks, so debt is
    // the sum of the per-rule counts, never just the overflow.
    const overLimit = lintDebt<{ debt: number; rules: Record<string, number> }>(
      'summarizeLintInvocations',
      [{ results: [{ messages }], maxWarnings: 1 }],
      [],
    );
    expect(overLimit.rules).toEqual({ 'import/order': 2, 'no-console': 1 });
    expect(overLimit.debt).toBe(3);
    const withinLimit = lintDebt<{ debt: number; rules: Record<string, number> }>(
      'summarizeLintInvocations',
      [{ results: [{ messages }], maxWarnings: 2 }],
      [],
    );
    expect(withinLimit.debt).toBe(1);
    expect(withinLimit.rules).toEqual({ 'no-console': 1 });
  });

  it('measures exactly the eslint invocation a lint target runs, and refuses one it cannot reproduce', () => {
    expect(
      lintDebt(
        'lintInvocations',
        {
          name: 'lib',
          root: 'libs/lib',
          targets: { lint: { executor: '@nx/eslint:lint', options: {} } },
        },
        {},
      ),
    ).toEqual([{ cwd: '.', mode: 'argv', args: ['libs/lib'], maxWarnings: null }]);
    expect(
      lintDebt(
        'lintInvocations',
        {
          name: 'web',
          root: 'web/x',
          targets: {
            lint: {
              executor: 'nx:run-commands',
              options: { cwd: 'web/x', command: 'npm run lint' },
            },
          },
        },
        { 'web/x': { lint: 'eslint src --max-warnings 0' } },
      ),
    ).toEqual([
      { cwd: 'web/x', mode: 'shell', command: 'eslint src --max-warnings 0', maxWarnings: 0 },
    ]);
    const chained = callLintDebt(
      'lintInvocations',
      {
        name: 'chained',
        root: 'x',
        targets: {
          lint: { executor: 'nx:run-commands', options: { command: 'tsc -b && eslint .' } },
        },
      },
      {},
    );
    expect(chained.status).not.toBe(0);
    expect(chained.stderr).toContain('not one plain eslint invocation');
    const custom = callLintDebt(
      'lintInvocations',
      { name: 'custom', root: 'x', targets: { lint: { executor: '@acme/lint:run', options: {} } } },
      {},
    );
    expect(custom.status).not.toBe(0);
    expect(custom.stderr).toContain('is not measurable');
  });
});
