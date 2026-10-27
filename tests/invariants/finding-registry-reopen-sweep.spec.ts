/**
 * MF-2 conformance audit R7c and R9b — the two writers whose success paths no
 * test pinned: `reopen` (both forms) and `sweep --event-paths`.
 *
 * ## Why
 *
 * `reopen` is the override that undoes a false closure. After MF-2 it is the
 * only way a human reverses a closure the projection derives from a merged
 * `Closes:` trailer, and it does so by appending one event to the finding's
 * own log: STATE_TRANSITIONED (a finding registered RESOLVED at birth, in
 * error) or CLOSURE_REJECTED (every closer the projection would still derive
 * on origin/main, rejected in one decision). A writer that appended the wrong
 * event, or none, or touched findings.jsonl, would leave a false closure in
 * place and every other test green: the repository held no test of either
 * success path, only of a refusal.
 *
 * `sweep --event-paths=<file>` is how the sweep lane declares its write set. The
 * lane's kernel preflight admits exactly the paths in that file, and the lane
 * stages exactly them into its PR (`CHANGED_PATHS`). If the flag wrote a
 * different list than the sweep appends to, the lane would either be refused
 * by its own contract or publish events it never declared.
 *
 * ## What these tests pin
 *
 *   - `reopen <id>` on a finding registered RESOLVED with no closer appends one
 *     STATE_TRANSITIONED RESOLVED to OPEN, anchored on the genesis row; the
 *     projection reads it OPEN, `verify` passes, findings.jsonl is untouched;
 *     on an OPEN finding it writes nothing.
 *   - `reopen <id> --reject-closure=<sha> --reason=<why>` appends one
 *     CLOSURE_REJECTED carrying the full sha and the reason; the projection
 *     reads the finding OPEN with the closer in `rejected_closing_commits`.
 *   - A rejection that leaves another merged closer standing is refused and
 *     writes nothing; rejecting every closer in one call is recorded.
 *   - `sweep --event-paths` lists, one repository-relative path per line,
 *     exactly the logs the sweep appends to (a dry run included, which writes
 *     none), every path is one the lane's kernel contract admits, and a sweep
 *     with nothing to do rewrites the file empty.
 *   - The workflow assigns `CHANGED_PATHS` from that same file, and declares
 *     the same file to its preflight.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';

import * as YAML from 'yaml';

import { type Finding } from '../../tools/gates/finding-registry-chain';

import {
  EVENT_STORE_RELATIVE_DIR,
  eventFilePath,
  type FindingEventLine,
  parseEvents,
} from './helpers/finding-event-fixture';
import {
  closesTrailer,
  type CliRun,
  fixtureFinding,
  parseJsonlRows,
  REGISTRY_RELATIVE_PATH,
  REPO_ROOT,
  RegistryFixtureRepo,
} from './helpers/registry-fixture-repo';

const SLOW_TEST_MS = 300_000;

/** Every event file under `root`'s store, repository-relative and sorted; none when no store exists. */
function eventFiles(root: string): string[] {
  const dir = join(root, EVENT_STORE_RELATIVE_DIR);
  if (!existsSync(dir)) return [];
  const walk = (at: string): string[] =>
    readdirSync(at).flatMap((name) => {
      const path = join(at, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  return walk(dir)
    .map((path) => relative(root, path).split(sep).join('/'))
    .sort();
}

function readEvents(root: string, id: string): FindingEventLine[] {
  return parseEvents(readFileSync(join(root, eventFilePath(id)), 'utf8'));
}

function expectOk(run: CliRun): void {
  expect({ status: run.status, stderr: run.status === 0 ? '' : run.stderr }).toEqual({
    status: 0,
    stderr: '',
  });
}

/** Drop what a test wrote into the working tree: the next test starts from the committed freeze. */
function resetWorkingTree(repo: RegistryFixtureRepo): void {
  repo.git(['reset', '-q', '--hard', 'HEAD']);
  repo.git(['clean', '-fdq', '--', EVENT_STORE_RELATIVE_DIR]);
}

describe('MF-2 R7c - reopen records the decision that undoes a closure', () => {
  const repo = RegistryFixtureRepo.create('mf2-reopen-');
  const REGISTERED_RESOLVED = 'ARIA-HIGH-902';
  const CLOSED_ONCE = 'ARIA-HIGH-901';
  const OPEN_ONE = 'ARIA-HIGH-903';
  const CLOSED_TWICE = 'ARIA-HIGH-904';
  let closer = '';
  let firstOfTwo = '';
  let secondOfTwo = '';
  let genesisRows: readonly Finding[] = [];
  let frozenRegistry = '';

  const genesisHash = (id: string): string => {
    const row = genesisRows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`${id} is not in the fixture registry`);
    return row.content_hash;
  };

  beforeAll(() => {
    repo.writeRegistry([
      fixtureFinding(CLOSED_ONCE),
      fixtureFinding(REGISTERED_RESOLVED, {
        state: 'RESOLVED',
        closing_commits: [],
        closed_at: '2026-10-02T00:00:00Z',
      }),
      fixtureFinding(OPEN_ONE),
      fixtureFinding(CLOSED_TWICE),
    ]);
    repo.commit('chore(registry): seed the legacy registry', '2026-10-01T10:00:00Z');
    closer = repo.commit(
      `fix(fixture): close ${CLOSED_ONCE}\n\n${closesTrailer(CLOSED_ONCE)}`,
      '2026-10-02T10:00:00Z',
    );
    firstOfTwo = repo.commit(
      `fix(fixture): close ${CLOSED_TWICE}\n\n${closesTrailer(CLOSED_TWICE)}`,
      '2026-10-03T10:00:00Z',
    );
    secondOfTwo = repo.commit(
      `fix(fixture): close ${CLOSED_TWICE} again\n\n${closesTrailer(CLOSED_TWICE)}`,
      '2026-10-04T10:00:00Z',
    );
    expectOk(repo.registry(['genesis']));
    repo.commit('chore(registry): freeze findings.jsonl', '2026-10-05T10:00:00Z');
    repo.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    frozenRegistry = repo.read(REGISTRY_RELATIVE_PATH);
    genesisRows = parseJsonlRows(frozenRegistry);
  }, SLOW_TEST_MS);

  afterEach(() => resetWorkingTree(repo));
  afterAll(() => repo.dispose());

  /** The projection's row for `id`, read by the real CLI. */
  const projected = (id: string): Finding & { rejected_closing_commits?: string[] } => {
    const run = repo.project();
    expectOk(run);
    const row = run.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`${id} is not in the projection`);
    return row;
  };

  const expectFrozenSegmentUntouched = (): void => {
    expect(repo.read(REGISTRY_RELATIVE_PATH)).toBe(frozenRegistry);
    expect(repo.git(['status', '--porcelain', '--', REGISTRY_RELATIVE_PATH]).trim()).toBe('');
  };

  it(
    'reopen of a finding registered RESOLVED with no closer appends one STATE_TRANSITIONED RESOLVED to OPEN',
    () => {
      const run = repo.registry(['reopen', REGISTERED_RESOLVED]);
      expectOk(run);
      expect(run.stdout).toContain(`Reopened: ${REGISTERED_RESOLVED}`);

      expect(eventFiles(repo.root)).toEqual([eventFilePath(REGISTERED_RESOLVED)]);
      const events = readEvents(repo.root, REGISTERED_RESOLVED);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(
        expect.objectContaining({
          finding_id: REGISTERED_RESOLVED,
          version: 1,
          event_type: 'STATE_TRANSITIONED',
          payload: { from_state: 'RESOLVED', to_state: 'OPEN' },
          prev_hash: genesisHash(REGISTERED_RESOLVED),
        }),
      );
      expect(typeof events[0]?.reason === 'string' && events[0].reason.trim() !== '').toBe(true);
      expect(typeof events[0]?.actor === 'string' && events[0].actor.trim() !== '').toBe(true);

      const row = projected(REGISTERED_RESOLVED);
      expect({ state: row.state, closing_commits: row.closing_commits }).toEqual({
        state: 'OPEN',
        closing_commits: [],
      });
      expectOk(repo.registry(['verify']));
      expectFrozenSegmentUntouched();
    },
    SLOW_TEST_MS,
  );

  it(
    'reopen of a finding that is already OPEN writes nothing',
    () => {
      const run = repo.registry(['reopen', OPEN_ONE]);
      expectOk(run);
      expect(run.stdout).toContain(`No-op: ${OPEN_ONE} is already OPEN`);
      expect(eventFiles(repo.root)).toEqual([]);
      expectFrozenSegmentUntouched();
    },
    SLOW_TEST_MS,
  );

  it(
    'reopen --reject-closure appends one CLOSURE_REJECTED, and the projection reads the finding OPEN with the closer rejected',
    () => {
      expect(projected(CLOSED_ONCE).state).toBe('RESOLVED');
      const reason = 'the commit named in the trailer did not fix it';
      const run = repo.registry([
        'reopen',
        CLOSED_ONCE,
        `--reject-closure=${closer}`,
        `--reason=${reason}`,
      ]);
      expectOk(run);
      expect(run.stdout).toContain(`Reopened: ${CLOSED_ONCE}`);

      expect(eventFiles(repo.root)).toEqual([eventFilePath(CLOSED_ONCE)]);
      const events = readEvents(repo.root, CLOSED_ONCE);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(
        expect.objectContaining({
          finding_id: CLOSED_ONCE,
          version: 1,
          event_type: 'CLOSURE_REJECTED',
          payload: { shas: [closer] },
          reason,
          prev_hash: genesisHash(CLOSED_ONCE),
        }),
      );

      const row = projected(CLOSED_ONCE);
      expect({
        state: row.state,
        closing_commits: row.closing_commits,
        rejected: row.rejected_closing_commits,
      }).toEqual({ state: 'OPEN', closing_commits: [], rejected: [closer] });
      expectOk(repo.registry(['verify']));
      expectFrozenSegmentUntouched();
    },
    SLOW_TEST_MS,
  );

  it(
    'a rejection that leaves another merged closer standing is refused, names that closer and writes nothing',
    () => {
      const run = repo.registry([
        'reopen',
        CLOSED_TWICE,
        `--reject-closure=${firstOfTwo}`,
        '--reason=the first commit did not fix it',
      ]);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(secondOfTwo.slice(0, 12));
      expect(eventFiles(repo.root)).toEqual([]);
      expect(projected(CLOSED_TWICE).state).toBe('RESOLVED');
      expectFrozenSegmentUntouched();
    },
    SLOW_TEST_MS,
  );

  it(
    'rejecting every closer in one call is recorded as one CLOSURE_REJECTED naming each',
    () => {
      const run = repo.registry([
        'reopen',
        CLOSED_TWICE,
        `--reject-closure=${firstOfTwo}`,
        `--reject-closure=${secondOfTwo}`,
        '--reason=neither commit fixed it',
      ]);
      expectOk(run);

      expect(eventFiles(repo.root)).toEqual([eventFilePath(CLOSED_TWICE)]);
      const events = readEvents(repo.root, CLOSED_TWICE);
      expect(events).toHaveLength(1);
      expect(events[0]?.event_type).toBe('CLOSURE_REJECTED');
      expect([...((events[0]?.payload.shas as string[] | undefined) ?? [])].sort()).toEqual(
        [firstOfTwo, secondOfTwo].sort(),
      );

      const row = projected(CLOSED_TWICE);
      expect(row.state).toBe('OPEN');
      expect([...(row.rejected_closing_commits ?? [])].sort()).toEqual(
        [firstOfTwo, secondOfTwo].sort(),
      );
      expectOk(repo.registry(['verify']));
      expectFrozenSegmentUntouched();
    },
    SLOW_TEST_MS,
  );
});

describe('MF-2 R9b - sweep --event-paths declares exactly the logs the sweep appends to', () => {
  const repo = RegistryFixtureRepo.create('mf2-sweep-paths-');
  const LAPSED_HIGH = 'ARIA-HIGH-901';
  const LAPSED_LOW = 'PROC-LOW-904';
  const NOT_DUE = 'ARIA-MEDIUM-903';
  const SWEEP = ['sweep', '--stale-after=36500'];
  const pathsFile = join(repo.root, 'event-paths.txt');
  /** The lane's kernel write contract, read from its single owner. */
  let contractPattern: RegExp;

  beforeAll(() => {
    // A lapsed deadline moves a finding to BLOCKED whatever the real clock says.
    repo.writeRegistry([
      fixtureFinding(LAPSED_HIGH, { deadline: '2026-01-31' }),
      fixtureFinding(NOT_DUE, { deadline: '2099-12-31' }),
      fixtureFinding(LAPSED_LOW, { deadline: '2026-01-31' }),
    ]);
    repo.commit('chore(registry): seed the legacy registry', '2026-10-01T10:00:00Z');
    expectOk(repo.registry(['genesis']));
    repo.commit('chore(registry): freeze findings.jsonl', '2026-10-02T10:00:00Z');

    const contracts = readFileSync(
      join(REPO_ROOT, 'aria-kernel/aria_kernel/workflow_contract_registry.py'),
      'utf8',
    );
    const sweepContract = contracts.slice(
      contracts.indexOf('"finding-state-sweep": WorkflowContract('),
    );
    const allowed = /allowed_write_path_patterns=\(([^)]*)\)/.exec(sweepContract)?.[1] ?? '';
    const pattern = /r"([^"]+)"/.exec(allowed)?.[1];
    if (pattern === undefined)
      throw new Error('the finding-state-sweep write contract has no pattern');
    contractPattern = new RegExp(pattern);
  }, SLOW_TEST_MS);

  afterEach(() => resetWorkingTree(repo));
  afterAll(() => repo.dispose());

  const declared = (): string[] =>
    readFileSync(pathsFile, 'utf8')
      .split('\n')
      .filter((line) => line !== '');

  it(
    'a dry run declares the logs a real run would append to and writes none',
    () => {
      const run = repo.registry([...SWEEP, '--dry-run', `--event-paths=${pathsFile}`]);
      expectOk(run);
      expect(declared()).toEqual([eventFilePath(LAPSED_HIGH), eventFilePath(LAPSED_LOW)]);
      expect(eventFiles(repo.root)).toEqual([]);
    },
    SLOW_TEST_MS,
  );

  it(
    'a real run appends to exactly the declared logs, each a path the lane contract admits',
    () => {
      const run = repo.registry([...SWEEP, `--event-paths=${pathsFile}`]);
      expectOk(run);
      const paths = declared();
      expect(paths).toEqual([eventFilePath(LAPSED_HIGH), eventFilePath(LAPSED_LOW)]);
      expect(eventFiles(repo.root)).toEqual([...paths].sort());
      expect(paths.filter((path) => !contractPattern.test(path))).toEqual([]);
      // Each declared path is one the PR step can stage: it exists and is repository-relative.
      expect(paths.filter((path) => !existsSync(join(repo.root, path)))).toEqual([]);
      for (const path of paths) {
        const events = parseEvents(readFileSync(join(repo.root, path), 'utf8'));
        expect(events.map((event) => event.event_type)).toEqual(['STATE_TRANSITIONED']);
      }
      // The lane's own post-sweep check: the sweep only appended.
      expectOk(repo.registry(['verify', '--base=HEAD']));
    },
    SLOW_TEST_MS,
  );

  it(
    'a sweep with nothing to do rewrites the declared file empty',
    () => {
      expectOk(repo.registry([...SWEEP, `--event-paths=${pathsFile}`]));
      expect(declared()).not.toEqual([]);
      writeFileSync(pathsFile, `${eventFilePath(NOT_DUE)}\n`, 'utf8');
      const clean = repo.registry([...SWEEP, `--event-paths=${pathsFile}`]);
      expectOk(clean);
      expect(clean.stdout).toContain('Sweep clean');
      expect(readFileSync(pathsFile, 'utf8')).toBe('');
    },
    SLOW_TEST_MS,
  );
});

describe('MF-2 R9b - finding-state-sweep.yml assigns CHANGED_PATHS from the file --event-paths writes', () => {
  interface Step {
    readonly name?: string;
    readonly run?: string;
  }
  const workflow = YAML.parse(
    readFileSync(join(REPO_ROOT, '.github/workflows/finding-state-sweep.yml'), 'utf8'),
  ) as { jobs: Record<string, { steps: Step[] }> };
  const runs = Object.values(workflow.jobs).flatMap((job) =>
    job.steps.flatMap((step) => (typeof step.run === 'string' ? [step.run] : [])),
  );
  const sweeps = runs.filter((run) => run.includes('finding-registry.ts sweep'));
  const eventPathsOf = (run: string): string | undefined =>
    /--event-paths="?([^"\s\\]+)"?/.exec(run)?.[1];

  it('both sweep invocations (the dry run and the apply) pass the same --event-paths file', () => {
    expect(sweeps).toHaveLength(2);
    expect(sweeps.filter((run) => run.includes('--dry-run'))).toHaveLength(1);
    const files = sweeps.map(eventPathsOf);
    expect(files[0]).toBeDefined();
    expect(files[1]).toBe(files[0]);
  });

  it('the PR step exports CHANGED_PATHS from that file before it opens the PR', () => {
    const file = eventPathsOf(sweeps[0] ?? '');
    const publish = runs.find((run) => run.includes('CHANGED_PATHS'));
    expect(publish).toBeDefined();
    const text = publish ?? '';
    const assigned = /CHANGED_PATHS="\$\(cat "([^"]+)"\)"/.exec(text)?.[1];
    expect(assigned).toBe(file);
    const exported = text.indexOf('export CHANGED_PATHS');
    expect(exported).toBeGreaterThan(-1);
    expect(
      text.indexOf('bash tools/scripts/automation/open-report-pr.sh', exported),
    ).toBeGreaterThan(exported);
  });

  it('the preflight declares exactly the logs in that file as the write set', () => {
    const file = eventPathsOf(sweeps[0] ?? '');
    const preflight = runs.find((run) => run.includes('verify_workflow_preflight'));
    expect(preflight).toBeDefined();
    const text = preflight ?? '';
    const read = /Path\(os\.environ\["RUNNER_TEMP"\], "([^"]+)"\)/.exec(text)?.[1];
    expect(read).toBeDefined();
    expect(posix.basename(file ?? '')).toBe(read);
    expect(text).toMatch(/allowed_write_roots=event_logs\b/);
    expect(text).toMatch(/path_allowlist=event_logs\b/);
  });
});
