/**
 * PROC-HIGH-046 + MF-2 — concurrent ARIA and registry PRs merge as GitHub
 * merges them: without a pinned file, and without a registry conflict.
 *
 * Until PROC-HIGH-046, `docs/aria/CURRENT_STATE.md` recorded a digest of the
 * whole ARIA authority surface and the enterprise-grade debt plan recorded
 * the registry tip, row count, state counts and active CRITICAL list. Every
 * PR that touched ARIA or added a finding rewrote those lines, so the second
 * of any two such PRs was stale or conflicting the moment the first merged
 * (17 of 17 ARIA merges and 78 of 78 registry merges on main since
 * 2026-09-18 rewrote them; 53 merge commits record hand-resolved conflicts in
 * the debt-plan files).
 *
 * Until MF-2 the registry itself was the remaining conflict: every new finding
 * was appended at the end of one hash-chained findings.jsonl, so two branches
 * that each recorded a finding conflicted under any line-based three-way
 * merge, and GitHub runs no merge driver. 141 "merge main into the branch"
 * syncs in 14 days had the registry changed on both sides, and all 141
 * conflicted (MF-DESIGN §1). MF-2 freezes findings.jsonl as a genesis segment
 * and records every later change as an event in one file per finding
 * (helpers/finding-event-fixture.ts), so different findings are different
 * paths.
 *
 * This spec replays the shapes on the REAL files — the current
 * CURRENT_STATE, the files its anchors name, the three debt-plan documents
 * and the whole registry directory — in a throwaway repository with no merge
 * driver registered:
 *
 *   - branch A records a finding and changes a kernel module, branch B records
 *     another and changes an executor; they merge with no conflict at all,
 *     and nothing formerly pinned is touched;
 *   - T1 (MF-DESIGN §7): A adds finding X, B adds Y, C merges a fix whose
 *     trailer closes Z, D sweeps W to STALE; every pairwise merge is clean and
 *     the merged projection holds X, Y, Z RESOLVED and W STALE, with
 *     findings.jsonl byte-identical to the base;
 *   - T2: two branches that change the SAME finding still conflict, on that
 *     finding's file — the real conflict stays visible.
 *
 * Then the guarantees the pins carried are shown red on the same real files: an
 * active CRITICAL with no truth-table row, and a kernel rename that leaves a
 * normative anchor dangling.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  CURRENT_STATE_PATH,
  checkCurrentState,
  currentStateAnchors,
} from '../../tools/gates/aria-authority-hash';
import {
  TRUTH_TABLE_PATH,
  checkDebtPlanTruth,
  deriveRegistrySnapshot,
  truthTableActiveRows,
} from '../../tools/gates/debt-plan-truth';
import { removeFixtureTree } from '../../tools/gates/fixture-tree';
import { type Finding, parseRegistryJsonl } from '../../tools/gates/finding-registry-chain';
import {
  projectRegistry,
  REGISTRY_RELATIVE_PATH,
} from '../../tools/gates/finding-registry-projection';
import { hermeticGitEnv } from '../../tools/gates/hermetic-git';

import {
  createdPayload,
  type EventDraft,
  eventFilePath,
  nextEvent,
  parseEvents,
  serializeEvents,
  transition,
} from './helpers/finding-event-fixture';

const REPO_ROOT = resolve(__dirname, '..', '..');
const DEBT_PLAN_DIR = 'docs/plans/2026-06-18-enterprise-grade-debt-closure';
const REGISTRY_DIR = 'docs/reviews/_registry';
const FIXTURE_REVIEW_FILE = 'docs/reviews/claude/2026-10-25-mf-2-derived-merge-fixture.md';

/** Every file that carried a pinned derived value before PROC-HIGH-046. */
const FORMERLY_PINNED = [
  CURRENT_STATE_PATH,
  `${DEBT_PLAN_DIR}/README.md`,
  `${DEBT_PLAN_DIR}/finding-truth-table.md`,
  `${DEBT_PLAN_DIR}/manifest.json`,
];

const HERMETIC_GIT_ENV: NodeJS.ProcessEnv = {
  ...hermeticGitEnv(),
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '5',
  GIT_CONFIG_KEY_0: 'gc.auto',
  GIT_CONFIG_VALUE_0: '0',
  GIT_CONFIG_KEY_1: 'maintenance.auto',
  GIT_CONFIG_VALUE_1: 'false',
  GIT_CONFIG_KEY_2: 'user.name',
  GIT_CONFIG_VALUE_2: 'Derived Pins Fixture',
  GIT_CONFIG_KEY_3: 'user.email',
  GIT_CONFIG_VALUE_3: 'fixture@example.invalid',
  GIT_CONFIG_KEY_4: 'commit.gpgsign',
  GIT_CONFIG_VALUE_4: 'false',
};

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: HERMETIC_GIT_ENV,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * The two files the branches change are taken from the document's own claims,
 * so the replay follows CURRENT_STATE as it evolves: a kernel module it anchors
 * both as a path and through a `::symbol` owner (renaming it must break both),
 * and an executor file it anchors under tools/aria-poc/.
 */
const REAL_ANCHORS = currentStateAnchors(readFileSync(join(REPO_ROOT, CURRENT_STATE_PATH), 'utf8'));
const KERNEL_ANCHOR = REAL_ANCHORS.symbols.find(
  (anchor) =>
    anchor.path.startsWith('aria-kernel/') &&
    REAL_ANCHORS.paths.some((pathAnchor) => pathAnchor.path === anchor.path),
);
const EXECUTOR_PATH = REAL_ANCHORS.paths.find(
  (anchor) => anchor.path.startsWith('tools/aria-poc/') && !anchor.path.endsWith('/'),
)?.path;

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`CURRENT_STATE no longer anchors ${what}`);
  return value;
}

function copyFromRepo(fixture: string, rel: string): void {
  mkdirSync(dirname(join(fixture, rel)), { recursive: true });
  writeFileSync(join(fixture, rel), readFileSync(join(REPO_ROOT, rel)));
}

function trackedUnder(prefix: string): string[] {
  return git(REPO_ROOT, ['ls-files', '--', prefix]).split('\n').filter(Boolean);
}

/**
 * The real files: the formerly pinned four, every tracked file of the
 * registry directory (the frozen genesis segment, its pin, the schemas, the
 * sidecars and the event store), and every anchor target.
 */
function seedPaths(): string[] {
  const targets = new Set<string>([...FORMERLY_PINNED, ...trackedUnder(`${REGISTRY_DIR}/`)]);
  for (const anchor of [...REAL_ANCHORS.paths, ...REAL_ANCHORS.symbols]) {
    if (anchor.path.endsWith('/')) {
      for (const rel of trackedUnder(anchor.path)) targets.add(rel);
    } else {
      targets.add(anchor.path);
    }
  }
  return [...targets].sort();
}

/** The genesis rows: the frozen findings.jsonl as the fixture holds it. */
function genesisRows(fixture: string): Finding[] {
  return parseRegistryJsonl(readFileSync(join(fixture, REGISTRY_RELATIVE_PATH), 'utf8'));
}

/**
 * Append one event to `findingId`'s log in the working tree, chained as the
 * store requires: line 1 anchors on the finding's genesis row, or on the
 * genesis tip for a finding the frozen segment does not hold.
 */
function appendEvent(fixture: string, findingId: string, draft: EventDraft): void {
  const rows = genesisRows(fixture);
  const legacy = rows.find((row) => row.id === findingId);
  const anchor = legacy?.content_hash ?? rows[rows.length - 1]?.content_hash ?? '';
  const path = join(fixture, eventFilePath(findingId));
  const prior = existsSync(path) ? parseEvents(readFileSync(path, 'utf8')) : [];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeEvents([...prior, nextEvent(findingId, prior, anchor, draft)]));
}

/** A new finding, recorded as a CREATED event in its own file. */
function recordFinding(fixture: string, row: Pick<Finding, 'id' | 'severity' | 'title'>): void {
  const created: Finding = {
    ...row,
    state: 'OPEN',
    layer: 1,
    evidence: ['tools/gates/finding-registry.ts:1'],
    owner_agent: 'claude',
    raised_in_cycle: '2026-10-25-mf-2-derived-merge-pins',
    review_file: FIXTURE_REVIEW_FILE,
    created_at: '2026-10-25T00:00:00Z',
    closed_at: null,
    closing_commits: [],
    deadline: '2099-12-31',
    owner_user: 'Okan-wqm',
    override_of: null,
    prev_hash: '',
    content_hash: '',
  };
  appendEvent(fixture, row.id, {
    event_type: 'CREATED',
    payload: createdPayload(created),
    reason: null,
    occurred_at: '2026-10-25T00:00:00Z',
  });
}

function appendLine(fixture: string, rel: string, line: string): void {
  const path = join(fixture, rel);
  writeFileSync(path, `${readFileSync(path, 'utf8')}${line}\n`, 'utf8');
}

function commitAll(fixture: string, message: string): string {
  git(fixture, ['add', '-A']);
  git(fixture, ['commit', '-q', '-m', message]);
  return git(fixture, ['rev-parse', 'HEAD']).trim();
}

/** A plain `git merge` (no driver registered): its exit status and the conflicted paths. */
function plainMerge(
  fixture: string,
  branch: string,
): { status: number | null; conflicted: string[] } {
  const merge = spawnSync('git', ['-C', fixture, 'merge', '--no-ff', '--no-edit', branch], {
    encoding: 'utf8',
    env: HERMETIC_GIT_ENV,
  });
  const conflicted = git(fixture, ['diff', '--name-only', '--diff-filter=U'])
    .split('\n')
    .filter(Boolean);
  return { status: merge.status, conflicted };
}

function debtPlanVerdict(fixture: string): ReturnType<typeof checkDebtPlanTruth> {
  return checkDebtPlanTruth(
    // The registry as readers see it: genesis rows and event logs, closures derived.
    deriveRegistrySnapshot(projectRegistry(fixture)),
    truthTableActiveRows(readFileSync(join(fixture, TRUTH_TABLE_PATH), 'utf8')),
  );
}

function projectedById(fixture: string): Map<string, Finding> {
  return new Map(projectRegistry(fixture).map((row) => [row.id, row]));
}

function changedSince(fixture: string, base: string): string[] {
  return git(fixture, ['diff', '--name-only', base, 'HEAD']).split('\n').filter(Boolean);
}

/**
 * Legacy findings the replay changes: OPEN in the base projection, not
 * CRITICAL (the debt plan would need a row), and anchored on a review file so
 * a `Closes:` trailer can name them exactly.
 */
function openLegacyFindings(fixture: string, count: number): Finding[] {
  const picked = projectRegistry(fixture).filter(
    (row) =>
      row.state === 'OPEN' &&
      row.severity !== 'CRITICAL' &&
      typeof row.review_file === 'string' &&
      row.review_file.startsWith('docs/reviews/'),
  );
  if (picked.length < count) {
    throw new Error(
      `the registry holds ${picked.length} OPEN legacy findings, the replay needs ${count}`,
    );
  }
  return picked.slice(0, count);
}

describe('PROC-HIGH-046 + MF-2 — concurrent ARIA and registry PRs merge without a pinned file or a registry conflict', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'derived-merge-pins-'));
  let base = '';
  let baseProjectionSize = 0;

  beforeAll(() => {
    git(fixture, ['init', '-q', '-b', 'main']);
    for (const rel of seedPaths()) copyFromRepo(fixture, rel);
    mkdirSync(dirname(join(fixture, FIXTURE_REVIEW_FILE)), { recursive: true });
    writeFileSync(join(fixture, FIXTURE_REVIEW_FILE), '# MF-2 derived-merge fixture review\n');
    commitAll(fixture, 'chore: seed the real formerly pinned files and the registry');
    base = git(fixture, ['rev-parse', 'HEAD']).trim();
    baseProjectionSize = projectRegistry(fixture).length;
  });

  afterAll(() => removeFixtureTree(fixture));

  it('starts green on the derived checks', () => {
    expect(checkCurrentState(fixture).defects).toEqual([]);
    expect(debtPlanVerdict(fixture)).toEqual({
      valid: true,
      missingRows: [],
      retiredRows: [],
      duplicateRows: [],
      invalidBuckets: [],
    });
  });

  it('merges two registry + ARIA branches with no conflict and the formerly pinned files untouched', () => {
    const kernelModule = required(KERNEL_ANCHOR, 'a kernel module with a symbol owner').path;
    const executor = required(EXECUTOR_PATH, 'a tools/aria-poc executor');
    git(fixture, ['checkout', '-q', '-b', 'branch-a', base]);
    recordFinding(fixture, {
      id: 'MOB-MEDIUM-901',
      severity: 'MEDIUM',
      title: 'branch A records a finding',
    });
    appendLine(fixture, kernelModule, '# branch A kernel change');
    commitAll(fixture, 'feat: branch A');
    expect(changedSince(fixture, base)).toEqual(
      [kernelModule, eventFilePath('MOB-MEDIUM-901')].sort(),
    );
    expect(checkCurrentState(fixture).valid).toBe(true);
    expect(debtPlanVerdict(fixture).valid).toBe(true);

    git(fixture, ['checkout', '-q', '-b', 'branch-b', base]);
    recordFinding(fixture, {
      id: 'MOB-HIGH-902',
      severity: 'HIGH',
      title: 'branch B records a finding',
    });
    appendLine(fixture, executor, '# branch B executor change');
    commitAll(fixture, 'feat: branch B');
    expect(changedSince(fixture, base)).toEqual([eventFilePath('MOB-HIGH-902'), executor].sort());
    expect(checkCurrentState(fixture).valid).toBe(true);
    expect(debtPlanVerdict(fixture).valid).toBe(true);

    // GitHub-shaped merge: no custom driver registered in this repository, and
    // none is needed — the two findings are two files.
    git(fixture, ['checkout', '-q', 'branch-a']);
    expect(plainMerge(fixture, 'branch-b')).toEqual({ status: 0, conflicted: [] });

    // The merged tree is green as it stands: nothing was re-stamped or repinned,
    // and the frozen genesis segment is byte-identical to the base.
    expect(git(fixture, ['diff', '--name-only', base, 'HEAD', '--', ...FORMERLY_PINNED])).toBe('');
    expect(git(fixture, ['diff', '--name-only', base, 'HEAD', '--', REGISTRY_RELATIVE_PATH])).toBe(
      '',
    );
    expect(checkCurrentState(fixture).defects).toEqual([]);
    expect(debtPlanVerdict(fixture).valid).toBe(true);
    const projected = projectedById(fixture);
    expect(projected.get('MOB-MEDIUM-901')?.state).toBe('OPEN');
    expect(projected.get('MOB-HIGH-902')?.state).toBe('OPEN');
    expect(projected.size).toBe(baseProjectionSize + 2);
  });

  it('T1 — adds, a trailer closure and a sweep merge pairwise without a conflict and project as merged', () => {
    git(fixture, ['checkout', '-q', base]);
    const [closed, swept] = openLegacyFindings(fixture, 2) as [Finding, Finding];
    const executor = required(EXECUTOR_PATH, 'a tools/aria-poc executor');

    git(fixture, ['checkout', '-q', '-b', 't1-a', base]);
    recordFinding(fixture, { id: 'MOB-MEDIUM-911', severity: 'MEDIUM', title: 'T1 finding X' });
    commitAll(fixture, 'chore(findings): record X');

    git(fixture, ['checkout', '-q', '-b', 't1-b', base]);
    recordFinding(fixture, { id: 'MOB-HIGH-912', severity: 'HIGH', title: 'T1 finding Y' });
    commitAll(fixture, 'chore(findings): record Y');

    // C: main merges a fix whose trailer closes Z; the registry is not written.
    git(fixture, ['checkout', '-q', '-b', 't1-fix', base]);
    appendLine(fixture, executor, '# the fix for Z');
    const fix = commitAll(
      fixture,
      `fix(fixture): close Z\n\nCloses: ${closed.review_file}#${closed.id}`,
    );
    git(fixture, ['checkout', '-q', '-b', 't1-c', base]);
    expect(plainMerge(fixture, 't1-fix')).toEqual({ status: 0, conflicted: [] });

    // D: the sweep moves W to STALE by appending to W's own log.
    git(fixture, ['checkout', '-q', '-b', 't1-d', base]);
    appendEvent(fixture, swept.id, {
      event_type: 'STATE_TRANSITIONED',
      payload: transition('OPEN', 'STALE'),
      actor: 'finding-state-sweep',
      reason: 'sweep: OPEN for more than 30 days',
      occurred_at: '2026-10-25T06:00:00Z',
    });
    commitAll(fixture, 'chore(findings): automated state sweep');

    const branches = ['t1-a', 't1-b', 't1-c', 't1-d'];
    const conflicts: string[] = [];
    for (const [i, left] of branches.entries()) {
      for (const right of branches.slice(i + 1)) {
        git(fixture, ['checkout', '-q', '-b', `t1-pair-${left}-${right}`, left]);
        const merged = plainMerge(fixture, right);
        if (merged.status !== 0) {
          conflicts.push(`${left} + ${right}: ${merged.conflicted.join(', ') || 'merge failed'}`);
          git(fixture, ['merge', '--abort']);
        }
      }
    }
    expect(conflicts).toEqual([]);

    git(fixture, ['checkout', '-q', '-b', 't1-all', 't1-a']);
    for (const branch of ['t1-b', 't1-c', 't1-d']) {
      expect(plainMerge(fixture, branch)).toEqual({ status: 0, conflicted: [] });
    }
    expect(git(fixture, ['diff', '--name-only', base, 'HEAD', '--', REGISTRY_RELATIVE_PATH])).toBe(
      '',
    );
    const projected = projectedById(fixture);
    expect(projected.get('MOB-MEDIUM-911')?.state).toBe('OPEN');
    expect(projected.get('MOB-HIGH-912')?.state).toBe('OPEN');
    expect(projected.get(closed.id)).toMatchObject({ state: 'RESOLVED', closing_commits: [fix] });
    expect(projected.get(swept.id)?.state).toBe('STALE');
  });

  it('T2 — two branches that change the same finding still conflict, on that finding only', () => {
    git(fixture, ['checkout', '-q', base]);
    const [, , amended] = openLegacyFindings(fixture, 3) as [Finding, Finding, Finding];
    const amend = (title: string): EventDraft => ({
      event_type: 'AMENDED',
      payload: { fields: { title } },
      reason: 'the title names the defect, not its symptom',
      occurred_at: '2026-10-25T07:00:00Z',
    });

    git(fixture, ['checkout', '-q', '-b', 't2-a', base]);
    appendEvent(fixture, amended.id, amend('the title as branch A words it'));
    commitAll(fixture, 'chore(findings): amend the title on branch A');
    // The file both branches write is the one the projection reads.
    expect(projectedById(fixture).get(amended.id)?.title).toBe('the title as branch A words it');

    git(fixture, ['checkout', '-q', '-b', 't2-b', base]);
    appendEvent(fixture, amended.id, amend('the title as branch B words it'));
    commitAll(fixture, 'chore(findings): amend the title on branch B');

    git(fixture, ['checkout', '-q', 't2-a']);
    const merged = plainMerge(fixture, 't2-b');
    expect(merged.status).not.toBe(0);
    expect(merged.conflicted).toEqual([eventFilePath(amended.id)]);
    git(fixture, ['merge', '--abort']);
  });

  it('still refuses an active CRITICAL that no truth-table row covers', () => {
    git(fixture, ['checkout', '-q', '-b', 'branch-critical', base]);
    recordFinding(fixture, {
      id: 'MOB-CRITICAL-903',
      severity: 'CRITICAL',
      title: 'a new active CRITICAL with no plan row',
    });
    commitAll(fixture, 'feat: an unplanned CRITICAL');
    const verdict = debtPlanVerdict(fixture);
    expect(verdict.valid).toBe(false);
    expect(verdict.missingRows).toEqual(['MOB-CRITICAL-903']);
  });

  it('still refuses a kernel rename that leaves a normative anchor dangling', () => {
    const anchor = required(KERNEL_ANCHOR, 'a kernel module with a symbol owner');
    git(fixture, ['checkout', '-q', '-b', 'branch-rename', base]);
    git(fixture, ['mv', anchor.path, anchor.path.replace(/\.py$/, '_renamed.py')]);
    commitAll(fixture, 'refactor: rename an anchored kernel module');
    const verdict = checkCurrentState(fixture);
    expect(verdict.valid).toBe(false);
    expect(verdict.defects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'unresolved_path', anchor: anchor.path }),
        expect.objectContaining({
          kind: 'unresolved_symbol',
          anchor: `${anchor.path}::${anchor.symbol}`,
        }),
      ]),
    );
  });
});
