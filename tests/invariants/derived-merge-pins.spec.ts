/**
 * PROC-HIGH-046 — two concurrent ARIA + registry PRs merge without touching
 * the files that used to carry pinned derived values.
 *
 * Until this finding, `docs/aria/CURRENT_STATE.md` recorded a digest of the
 * whole ARIA authority surface and the enterprise-grade debt plan recorded
 * the registry tip, row count, state counts and active CRITICAL list. Every
 * PR that touched ARIA or added a finding rewrote those lines, so the second
 * of any two such PRs was stale or conflicting the moment the first merged
 * (17 of 17 ARIA merges and 78 of 78 registry merges on main since
 * 2026-09-18 rewrote them; 53 merge commits record hand-resolved conflicts in
 * the debt-plan files).
 *
 * This spec replays the exact shape on the REAL files — the current
 * CURRENT_STATE, the files its anchors name, the three debt-plan documents
 * and the registry — in a throwaway repository:
 *
 *   - branch A adds a registry row and changes a kernel module;
 *   - branch B adds a different registry row and changes an executor;
 *   - neither branch touches a formerly pinned file, both are green on the
 *     derived checks as they stand, and their merge is green with no re-stamp.
 *
 * The merge runs without custom drivers, which is how GitHub merges. The one
 * conflict it reports is the registry's own tail append — the shape the
 * `findings-registry` driver exists for (tools/gates/finding-registry-merge.ts),
 * resolved here by the same function the driver runs. That conflict is not one
 * of the pins and is asserted explicitly so it cannot hide one.
 *
 * Then the guarantees the pins carried are shown red on the same real files: an
 * active CRITICAL with no truth-table row, and a kernel rename that leaves a
 * normative anchor dangling.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  CURRENT_STATE_PATH,
  checkCurrentState,
  currentStateAnchors,
} from '../../tools/gates/aria-authority-hash';
import {
  REGISTRY_PATH,
  TRUTH_TABLE_PATH,
  checkDebtPlanTruth,
  deriveRegistrySnapshot,
  truthTableActiveRows,
} from '../../tools/gates/debt-plan-truth';
import { removeFixtureTree } from '../../tools/gates/fixture-tree';
import {
  type Finding,
  parseRegistryJsonl,
  rechain,
  serializeRegistryJsonl,
  verify,
} from '../../tools/gates/finding-registry-chain';
import { mergeRegistryText } from '../../tools/gates/finding-registry-merge';

const REPO_ROOT = resolve(__dirname, '..', '..');
const DEBT_PLAN_DIR = 'docs/plans/2026-06-18-enterprise-grade-debt-closure';

/** Every file that carried a pinned derived value before PROC-HIGH-046. */
const FORMERLY_PINNED = [
  CURRENT_STATE_PATH,
  `${DEBT_PLAN_DIR}/README.md`,
  `${DEBT_PLAN_DIR}/finding-truth-table.md`,
  `${DEBT_PLAN_DIR}/manifest.json`,
];

const HERMETIC_GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
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

/** The real files: the formerly pinned four, the registry, and every anchor target. */
function seedPaths(): string[] {
  const targets = new Set<string>([...FORMERLY_PINNED, REGISTRY_PATH]);
  for (const anchor of [...REAL_ANCHORS.paths, ...REAL_ANCHORS.symbols]) {
    if (anchor.path.endsWith('/')) {
      for (const rel of git(REPO_ROOT, ['ls-files', '--', anchor.path])
        .split('\n')
        .filter(Boolean)) {
        targets.add(rel);
      }
    } else {
      targets.add(anchor.path);
    }
  }
  return [...targets].sort();
}

function appendFinding(fixture: string, row: Pick<Finding, 'id' | 'severity' | 'title'>): void {
  const path = join(fixture, REGISTRY_PATH);
  const entries = parseRegistryJsonl(readFileSync(path, 'utf8'));
  entries.push({
    ...row,
    state: 'OPEN',
    owner_agent: 'claude',
    raised_in_cycle: '2026-10-02-derived-merge-pins',
    created_at: '2026-10-02T21:00:00Z',
    closed_at: null,
    closing_commits: [],
    deadline: '2026-10-06',
    owner_user: 'okan',
    override_of: null,
    prev_hash: '',
    content_hash: '',
  });
  rechain(entries, entries.length - 1);
  writeFileSync(path, serializeRegistryJsonl(entries), 'utf8');
}

function appendLine(fixture: string, rel: string, line: string): void {
  const path = join(fixture, rel);
  writeFileSync(path, `${readFileSync(path, 'utf8')}${line}\n`, 'utf8');
}

function commitAll(fixture: string, message: string): void {
  git(fixture, ['add', '-A']);
  git(fixture, ['commit', '-q', '-m', message]);
}

function debtPlanVerdict(fixture: string): ReturnType<typeof checkDebtPlanTruth> {
  return checkDebtPlanTruth(
    deriveRegistrySnapshot(readFileSync(join(fixture, REGISTRY_PATH), 'utf8')),
    truthTableActiveRows(readFileSync(join(fixture, TRUTH_TABLE_PATH), 'utf8')),
  );
}

function changedSince(fixture: string, base: string): string[] {
  return git(fixture, ['diff', '--name-only', base, 'HEAD']).split('\n').filter(Boolean);
}

describe('PROC-HIGH-046 — concurrent ARIA and registry PRs merge without a pinned file', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'derived-merge-pins-'));
  let base = '';

  beforeAll(() => {
    git(fixture, ['init', '-q', '-b', 'main']);
    for (const rel of seedPaths()) copyFromRepo(fixture, rel);
    commitAll(fixture, 'chore: seed the real formerly pinned files');
    base = git(fixture, ['rev-parse', 'HEAD']).trim();
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

  it('merges two registry + ARIA branches with the formerly pinned files untouched', () => {
    const kernelModule = required(KERNEL_ANCHOR, 'a kernel module with a symbol owner').path;
    const executor = required(EXECUTOR_PATH, 'a tools/aria-poc executor');
    git(fixture, ['checkout', '-q', '-b', 'branch-a', base]);
    appendFinding(fixture, {
      id: 'ZZFIX-MEDIUM-901',
      severity: 'MEDIUM',
      title: 'branch A records a finding',
    });
    appendLine(fixture, kernelModule, '# branch A kernel change');
    commitAll(fixture, 'feat: branch A');
    expect(changedSince(fixture, base)).toEqual([kernelModule, REGISTRY_PATH].sort());
    expect(checkCurrentState(fixture).valid).toBe(true);
    expect(debtPlanVerdict(fixture).valid).toBe(true);

    git(fixture, ['checkout', '-q', '-b', 'branch-b', base]);
    appendFinding(fixture, {
      id: 'ZZFIX-HIGH-902',
      severity: 'HIGH',
      title: 'branch B records a finding',
    });
    appendLine(fixture, executor, '# branch B executor change');
    commitAll(fixture, 'feat: branch B');
    expect(changedSince(fixture, base)).toEqual([REGISTRY_PATH, executor].sort());
    expect(checkCurrentState(fixture).valid).toBe(true);
    expect(debtPlanVerdict(fixture).valid).toBe(true);

    // GitHub-shaped merge: no custom driver registered in this repository.
    git(fixture, ['checkout', '-q', 'branch-a']);
    const merge = spawnSync('git', ['-C', fixture, 'merge', '--no-ff', '--no-edit', 'branch-b'], {
      encoding: 'utf8',
      env: HERMETIC_GIT_ENV,
    });
    const conflicted = git(fixture, ['diff', '--name-only', '--diff-filter=U'])
      .split('\n')
      .filter(Boolean);
    // The only conflict is the registry's own tail append; no formerly pinned
    // file is among them, which is the point.
    expect(conflicted).toEqual([REGISTRY_PATH]);
    expect(merge.status).not.toBe(0);
    for (const rel of FORMERLY_PINNED) expect(conflicted).not.toContain(rel);

    // Resolve the registry exactly as the findings-registry driver does.
    const merged = mergeRegistryText(
      git(fixture, ['show', `:1:${REGISTRY_PATH}`]),
      git(fixture, ['show', `:2:${REGISTRY_PATH}`]),
      git(fixture, ['show', `:3:${REGISTRY_PATH}`]),
    );
    if (!merged.ok) throw new Error(`registry merge refused: ${merged.reason}`);
    writeFileSync(join(fixture, REGISTRY_PATH), merged.text, 'utf8');
    git(fixture, ['add', REGISTRY_PATH]);
    git(fixture, ['commit', '-q', '--no-edit']);

    // The merged tree is green as it stands: nothing was re-stamped or repinned.
    expect(git(fixture, ['diff', '--name-only', base, 'HEAD', '--', ...FORMERLY_PINNED])).toBe('');
    expect(checkCurrentState(fixture).defects).toEqual([]);
    expect(debtPlanVerdict(fixture).valid).toBe(true);
    const registryAfter = readFileSync(join(fixture, REGISTRY_PATH), 'utf8');
    const entries = parseRegistryJsonl(registryAfter);
    expect(verify(entries).ok).toBe(true);
    expect(entries.slice(-2).map((entry) => entry.id)).toEqual([
      'ZZFIX-HIGH-902',
      'ZZFIX-MEDIUM-901',
    ]);
    const baseEntries = deriveRegistrySnapshot(
      git(fixture, ['show', `${base}:${REGISTRY_PATH}`]),
    ).entries;
    expect(deriveRegistrySnapshot(registryAfter).entries).toBe(baseEntries + 2);
  });

  it('still refuses an active CRITICAL that no truth-table row covers', () => {
    git(fixture, ['checkout', '-q', '-b', 'branch-critical', base]);
    appendFinding(fixture, {
      id: 'ZZFIX-CRITICAL-903',
      severity: 'CRITICAL',
      title: 'a new active CRITICAL with no plan row',
    });
    commitAll(fixture, 'feat: an unplanned CRITICAL');
    const verdict = debtPlanVerdict(fixture);
    expect(verdict.valid).toBe(false);
    expect(verdict.missingRows).toEqual(['ZZFIX-CRITICAL-903']);
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
