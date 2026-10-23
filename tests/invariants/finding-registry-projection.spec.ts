/**
 * MF-1 (PROC-HIGH-039) — RESOLVED is derived from merged `Closes:` trailers at
 * read time, by one projection module, and nothing writes it.
 *
 * ## Why
 *
 * `state: RESOLVED` in findings.jsonl copied a fact the `Closes:` trailer
 * already records, and the trailer is immutable and enforced by
 * commit-msg-validator. The copy lagged, so a drift gate existed to notice the
 * lag, a `reconcile` command existed to refresh the copy, and a lane existed to
 * run it and merge the result: every closer merge moved main twice and left
 * the push run red until the second move (63 of 157 merges, 64 red runs, a
 * 121 h drift window over 14 days; MF-DESIGN §1).
 *
 * ## What these tests pin (MF-DESIGN §4.4, §7 T3/T4/T11, §5 MF-1)
 *
 *   - T3: a trailer reachable from the ref closes the finding in the
 *     projection, with the closer recorded and `closed_at` the date of the
 *     first first-parent commit of the ref that contains it; a rejected
 *     closer, an unmerged branch and a control row do not; an alias trailer
 *     does; a legacy RESOLVED row keeps its recorded closure; projecting writes
 *     nothing.
 *   - T4: main is green at the closer merge itself — no reconcile commit is
 *     needed for the chain, the debt-plan truth table or the projection.
 *   - T11: the projection over this repository is fast enough to be read on
 *     every CI run and by every kernel reader (under 10 s).
 *   - Parity on this repository: every recorded RESOLVED row projects as
 *     recorded, and every other row projects as recorded or as a derived
 *     closure; a real drift window on main (ARIA-HIGH-012 at #2067's merge,
 *     recorded STALE until reconcile #2075) projects RESOLVED at that merge.
 *   - The CLI surface: `project` exists; `close`, `reconcile` and
 *     `verify --closures-at` are gone (T5's CLI half for MF-1).
 *   - One owner: closure derivation is defined only in
 *     tools/gates/finding-registry-projection.ts, the closure-admission
 *     helpers are consumed only by it, and the readers MF-1 switches read
 *     through it instead of building a path to findings.jsonl.
 *
 * The CLI is the contract the design names
 * (`project [--ref=<rev>] [--ids …] [--format=jsonl|csv|json-array]`), run
 * from a throwaway repository that carries a copy of tools/gates
 * (helpers/registry-fixture-repo.ts), so the history under test is the
 * fixture's own.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { type Finding, parseRegistryJsonl } from '../../tools/gates/finding-registry-chain';
import {
  closesTrailer,
  FIXTURE_ALIAS_REVIEW_FILE,
  fixtureFinding,
  type ProjectionRun,
  REGISTRY_RELATIVE_PATH,
  REPO_ROOT,
  RegistryFixtureRepo,
  runProjection,
} from './helpers/registry-fixture-repo';

const PROJECTION_MODULE = 'tools/gates/finding-registry-projection.ts';
const CLI_TEST_TIMEOUT_MS = 180_000;

function byId(rows: readonly Finding[]): Map<string, Finding> {
  return new Map(rows.map((row) => [row.id, row]));
}

function expectProjected(run: ProjectionRun): Map<string, Finding> {
  expect({ status: run.status, stderr: run.status === 0 ? '' : run.stderr }).toEqual({
    status: 0,
    stderr: '',
  });
  return byId(run.rows);
}

function sameInstant(left: string | null | undefined, right: string): boolean {
  return typeof left === 'string' && Date.parse(left) === Date.parse(right);
}

describe('MF-1 T3 — the projection derives RESOLVED from merged Closes: trailers', () => {
  const repo = RegistryFixtureRepo.create('mf1-projection-');
  const shas = {
    seed: '',
    rejected: '',
    alias: '',
    registry: '',
    fix901: '',
    merge901: '',
    wip905: '',
  };
  let registryAtMain = '';

  beforeAll(() => {
    repo.writeRegistry([
      fixtureFinding('ARIA-HIGH-901'),
      fixtureFinding('ARIA-HIGH-902'),
      fixtureFinding('ARIA-HIGH-903'),
      fixtureFinding('ARIA-HIGH-904', {
        state: 'RESOLVED',
        closing_commits: ['abcdef1'],
        closed_at: '2026-09-01T00:00:00.000Z',
      }),
      fixtureFinding('ARIA-HIGH-905'),
      fixtureFinding('ARIA-MEDIUM-906'),
    ]);
    shas.seed = repo.commit('chore(registry): seed the fixture registry', '2026-10-01T10:00:00Z');

    // A closer an override reopen later rejects.
    shas.rejected = repo.commit(
      `fix(fixture): first attempt at 902\n\n${closesTrailer('ARIA-HIGH-902')}`,
      '2026-10-02T10:00:00Z',
    );
    // A closer that names 903 by its historical alias, committed on main itself.
    shas.alias = repo.commit(
      `fix(fixture): close 903 under its historical id\n\n${closesTrailer('PR999-HIGH-001', FIXTURE_ALIAS_REVIEW_FILE)}`,
      '2026-10-03T10:00:00Z',
    );
    repo.writeAliases([
      {
        alias: 'PR999-HIGH-001',
        canonical: 'ARIA-HIGH-903',
        review_file: FIXTURE_ALIAS_REVIEW_FILE,
        commits: [shas.alias.slice(0, 9)],
      },
    ]);
    repo.writeRegistry([
      fixtureFinding('ARIA-HIGH-901'),
      fixtureFinding('ARIA-HIGH-902', { rejected_closing_commits: [shas.rejected] }),
      fixtureFinding('ARIA-HIGH-903'),
      fixtureFinding('ARIA-HIGH-904', {
        state: 'RESOLVED',
        closing_commits: ['abcdef1'],
        closed_at: '2026-09-01T00:00:00.000Z',
      }),
      fixtureFinding('ARIA-HIGH-905'),
      fixtureFinding('ARIA-MEDIUM-906'),
    ]);
    shas.registry = repo.commit(
      'chore(registry): reject the first closer of 902 and record the 903 alias',
      '2026-10-04T10:00:00Z',
    );

    // A fix branch merged into main two days after its commit.
    repo.git(['checkout', '-q', '-b', 'fix-901']);
    shas.fix901 = repo.commit(
      `fix(fixture): close 901\n\n${closesTrailer('ARIA-HIGH-901')}`,
      '2026-10-05T10:00:00Z',
    );
    repo.git(['checkout', '-q', 'main']);
    shas.merge901 = repo.merge('fix-901', '2026-10-07T10:00:00Z');

    // A fix on a branch that never merges.
    repo.git(['checkout', '-q', '-b', 'wip-905']);
    shas.wip905 = repo.commit(
      `fix(fixture): close 905 on a branch that does not merge\n\n${closesTrailer('ARIA-HIGH-905')}`,
      '2026-10-08T10:00:00Z',
    );
    repo.git(['checkout', '-q', 'main']);
    registryAtMain = repo.read(REGISTRY_RELATIVE_PATH);
  });

  afterAll(() => repo.dispose());

  it(
    'closes a finding whose trailer a merge brought into the ref, dated by that merge',
    () => {
      const rows = expectProjected(repo.project());
      const row = rows.get('ARIA-HIGH-901');
      expect(row?.state).toBe('RESOLVED');
      expect(row?.closing_commits).toEqual([shas.fix901]);
      // The merge into the ref, not the fix commit and not the wall clock.
      expect(row?.closed_at).toEqual(expect.any(String));
      expect(sameInstant(row?.closed_at, repo.committerDate(shas.merge901))).toBe(true);
      expect(sameInstant(row?.closed_at, repo.committerDate(shas.fix901))).toBe(false);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'writes nothing: the registry bytes and the working tree are untouched',
    () => {
      expectProjected(repo.project());
      expect(repo.read(REGISTRY_RELATIVE_PATH)).toBe(registryAtMain);
      expect(repo.status()).toBe('');
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'keeps a finding OPEN whose only closer an override reopen rejected',
    () => {
      const row = expectProjected(repo.project()).get('ARIA-HIGH-902');
      expect(row?.state).toBe('OPEN');
      expect(row?.closing_commits).toEqual([]);
      expect(row?.closed_at).toBeNull();
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'resolves a trailer that names the finding by its recorded alias',
    () => {
      const row = expectProjected(repo.project()).get('ARIA-HIGH-903');
      expect(row?.state).toBe('RESOLVED');
      expect(row?.closing_commits).toEqual([shas.alias]);
      // Committed on main itself: the first first-parent commit holding it is itself.
      expect(sameInstant(row?.closed_at, repo.committerDate(shas.alias))).toBe(true);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'keeps a legacy RESOLVED row with no trailer exactly as recorded',
    () => {
      const row = expectProjected(repo.project()).get('ARIA-HIGH-904');
      expect([row?.state, row?.closing_commits, row?.closed_at]).toEqual([
        'RESOLVED',
        ['abcdef1'],
        '2026-09-01T00:00:00.000Z',
      ]);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'does not close a finding from a branch the ref does not contain, and does at that branch',
    () => {
      const atMain = expectProjected(repo.project()).get('ARIA-HIGH-905');
      expect(atMain?.state).toBe('OPEN');
      const atBranch = expectProjected(repo.project(['--ref=wip-905', '--ids', 'ARIA-HIGH-905']));
      expect([...atBranch.keys()]).toEqual(['ARIA-HIGH-905']);
      expect(atBranch.get('ARIA-HIGH-905')?.state).toBe('RESOLVED');
      expect(atBranch.get('ARIA-HIGH-905')?.closing_commits).toEqual([shas.wip905]);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'leaves a finding no trailer names as recorded, one row per finding',
    () => {
      const run = repo.project();
      const rows = expectProjected(run);
      expect(rows.get('ARIA-MEDIUM-906')?.state).toBe('OPEN');
      expect(run.rows.map((row) => row.id).sort()).toEqual([
        'ARIA-HIGH-901',
        'ARIA-HIGH-902',
        'ARIA-HIGH-903',
        'ARIA-HIGH-904',
        'ARIA-HIGH-905',
        'ARIA-MEDIUM-906',
      ]);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'exposes no command that writes RESOLVED: close, reconcile and verify --closures-at are gone',
    () => {
      const usage = repo.registry([]);
      expect(usage.status).toBe(2);
      expect(usage.stderr).not.toMatch(/\bclose\b|\breconcile\b|--closures-at/);
      expect(usage.stderr).toMatch(/\bproject\b/);
      // A nonexistent id: on a CLI that still has `close` this refuses without writing.
      const close = repo.registry(['close', 'ARIA-HIGH-999', shas.fix901]);
      expect([close.status, close.stderr]).toEqual([
        2,
        expect.stringMatching(/Unknown subcommand/),
      ]);
      const reconcile = repo.registry(['reconcile', '--dry-run']);
      expect([reconcile.status, reconcile.stderr]).toEqual([
        2,
        expect.stringMatching(/Unknown subcommand/),
      ]);
      const closuresAt = repo.registry([
        'verify',
        '--stdin',
        '--closures-at',
        shas.fix901,
        'ARIA-HIGH-901',
      ]);
      expect(closuresAt.status).toBe(2);
      expect(repo.read(REGISTRY_RELATIVE_PATH)).toBe(registryAtMain);
    },
    CLI_TEST_TIMEOUT_MS,
  );
});

describe('MF-1 T4 — main is green at the closer merge, with no follow-up commit', () => {
  const repo = RegistryFixtureRepo.create('mf1-green-at-merge-');
  let seed = '';
  let fix = '';
  let merge = '';

  beforeAll(() => {
    repo.writeRegistry([fixtureFinding('ARIA-CRITICAL-911'), fixtureFinding('ARIA-HIGH-912')]);
    repo.writeTruthTable(['ARIA-CRITICAL-911']);
    seed = repo.commit(
      'chore(registry): an active CRITICAL with its plan row',
      '2026-10-01T10:00:00Z',
    );
    repo.git(['checkout', '-q', '-b', 'fix-911']);
    // The fix PR carries its own closure (the trailer) and retires the plan row
    // in the same PR (MF-DESIGN §4.6); it writes nothing to the registry.
    repo.writeTruthTable([]);
    fix = repo.commit(
      `fix(fixture): close the CRITICAL\n\n${closesTrailer('ARIA-CRITICAL-911')}`,
      '2026-10-02T10:00:00Z',
    );
    repo.git(['checkout', '-q', 'main']);
    merge = repo.merge('fix-911', '2026-10-03T10:00:00Z');
  });

  afterAll(() => repo.dispose());

  it(
    'the merge itself carries the closure; the registry is unchanged since the seed',
    () => {
      expect(repo.head()).toBe(merge);
      expect(repo.git(['diff', '--name-only', seed, 'HEAD', '--', 'docs/reviews/_registry'])).toBe(
        '',
      );
      const row = expectProjected(repo.project()).get('ARIA-CRITICAL-911');
      expect(row?.state).toBe('RESOLVED');
      expect(row?.closing_commits).toEqual([fix]);
      expect(sameInstant(row?.closed_at, repo.committerDate(merge))).toBe(true);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'the chain verifies and the debt-plan truth table agrees at the merge',
    () => {
      const verify = repo.registry(['verify']);
      expect([verify.status, verify.stderr]).toEqual([0, '']);
      const truth = repo.debtPlanTruth();
      expect({ status: truth.status, stderr: truth.stderr }).toEqual({ status: 0, stderr: '' });
      expect(repo.status()).toBe('');
    },
    CLI_TEST_TIMEOUT_MS,
  );
});

describe('MF-1 — the projection over this repository', () => {
  let run: ProjectionRun;
  const recorded = parseRegistryJsonl(
    readFileSync(join(REPO_ROOT, REGISTRY_RELATIVE_PATH), 'utf8'),
  );

  beforeAll(() => {
    run = runProjection(REPO_ROOT);
  }, CLI_TEST_TIMEOUT_MS);

  it('T11 — finishes in under 10 s, ts-node start-up included', () => {
    expect(run.status).toBe(0);
    expect(run.ms).toBeLessThan(10_000);
  });

  it('agrees with every recorded state: a recorded closure as recorded, any other as recorded or derived', () => {
    const projected = expectProjected(run);
    expect(projected.size).toBe(recorded.length);
    const disagreements: string[] = [];
    for (const row of recorded) {
      const view = projected.get(row.id);
      if (view === undefined) {
        disagreements.push(`${row.id}: missing from the projection`);
        continue;
      }
      if (row.state === 'RESOLVED') {
        if (
          view.state !== 'RESOLVED' ||
          JSON.stringify(view.closing_commits) !== JSON.stringify(row.closing_commits) ||
          view.closed_at !== row.closed_at
        ) {
          disagreements.push(`${row.id}: recorded closure not kept`);
        }
        continue;
      }
      const derived =
        view.state === 'RESOLVED' &&
        view.closing_commits.length === 1 &&
        /^[0-9a-f]{40}$/.test(view.closing_commits[0] ?? '');
      if (view.state !== row.state && !derived) {
        disagreements.push(`${row.id}: recorded ${row.state}, projected ${view.state}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it(
    'projects a real drift window as closed: ARIA-HIGH-012 at the merge of #2067',
    () => {
      // a62b291c3 merged #2067, whose 78d38a761 carries
      // `Closes: …#ARIA-HIGH-012`; the registry at that commit still records
      // STALE, and reconcile PR #2075 wrote RESOLVED afterwards. The
      // projection at the merge needs no second commit.
      const merge = 'a62b291c3a7ea6650c60002d75ac51f53fad08cc';
      const closer = '78d38a76118b10b391364506ab1340d6921b5129';
      const recordedThen = execFileSync(
        'git',
        ['-C', REPO_ROOT, 'show', `${merge}:${REGISTRY_RELATIVE_PATH}`],
        { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
      );
      expect(
        parseRegistryJsonl(recordedThen).find((row) => row.id === 'ARIA-HIGH-012')?.state,
      ).toBe('STALE');
      const rows = expectProjected(
        runProjection(REPO_ROOT, [`--ref=${merge}`, '--ids', 'ARIA-HIGH-012']),
      );
      const row = rows.get('ARIA-HIGH-012');
      expect([row?.state, row?.closing_commits]).toEqual(['RESOLVED', [closer]]);
      expect(sameInstant(row?.closed_at, '2026-10-23T01:23:19Z')).toBe(true);
    },
    CLI_TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// One owner of closure derivation (MF-DESIGN §4.4)
// ---------------------------------------------------------------------------

const DERIVATION_FUNCTIONS = [
  'collectMergedClosures',
  'listMergedClosers',
  'withFindingAliases',
  'readMergedCommits',
];
const ADMISSION_HELPERS = [
  'closureAdmissible',
  'commitHasFindingCloseTrailer',
  'findingRejectsClosure',
];
const READERS_SWITCHED_TO_THE_PROJECTION = [
  'tools/gates/commit-msg-validator.ts',
  'tools/gates/compliance-attestation-coverage.ts',
  'tools/gates/banned-phrase-excuse.ts',
  'tools/audit/aggregate-hotspots.ts',
  'tools/gates/debt-plan-truth.ts',
];

/** Every non-spec TypeScript source under tools/, repo-relative. */
function toolSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'fixtures') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts')) {
        out.push(relative(REPO_ROOT, path).split(sep).join('/'));
      }
    }
  };
  walk(join(REPO_ROOT, 'tools'));
  return out.sort();
}

function source(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

/** Names a file imports from a module whose specifier ends in `/<moduleName>`. */
function namedImportsFrom(text: string, moduleName: string): string[] {
  const names: string[] = [];
  const pattern = new RegExp(
    `import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*['"][^'"]*/${moduleName}['"]`,
    'g',
  );
  for (const match of text.matchAll(pattern)) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part
        .replace(/^\s*type\s+/, '')
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/** A path to findings.jsonl built in code: a resolve/join argument or a constant. */
const REGISTRY_PATH_CONSTRUCTION = [
  /\b(?:resolve|join)\([^)]*['"`]findings\.jsonl['"`]/,
  /(?:const|let|var)\s+\w+\s*(?::\s*\w+\s*)?=\s*['"`][^'"`\n]*_registry\/findings\.jsonl['"`]/,
];

describe('MF-1 — one owner of closure derivation', () => {
  const sources = toolSources();

  it('the projection module exists', () => {
    expect(sources).toContain(PROJECTION_MODULE);
  });

  it('defines the derivation from merged history only in the projection module', () => {
    const definers = sources.flatMap((rel) =>
      DERIVATION_FUNCTIONS.filter((name) =>
        new RegExp(`\\bfunction\\s+${name}\\b`).test(source(rel)),
      ).map((name) => `${rel}:${name}`),
    );
    expect(definers.filter((entry) => !entry.startsWith(`${PROJECTION_MODULE}:`))).toEqual([]);
  });

  it('consumes the closure-admission helpers only in the projection module', () => {
    const consumers = sources
      .filter((rel) => rel !== 'tools/gates/finding-traceability.ts')
      .flatMap((rel) =>
        namedImportsFrom(source(rel), 'finding-traceability')
          .filter((name) => ADMISSION_HELPERS.includes(name))
          .map((name) => `${rel}:${name}`),
      );
    expect(consumers.filter((entry) => !entry.startsWith(`${PROJECTION_MODULE}:`))).toEqual([]);
  });

  it('the readers MF-1 switches read the registry through the projection, not by path', () => {
    const offenders = READERS_SWITCHED_TO_THE_PROJECTION.flatMap((rel) => {
      const text = source(rel);
      const problems: string[] = [];
      if (!/from\s*['"][^'"]*\/finding-registry-projection['"]/.test(text)) {
        problems.push(`${rel}: does not import the projection`);
      }
      if (REGISTRY_PATH_CONSTRUCTION.some((pattern) => pattern.test(text))) {
        problems.push(`${rel}: builds its own path to findings.jsonl`);
      }
      return problems;
    });
    expect(offenders).toEqual([]);
  });
});
