/**
 * ARIA-MEDIUM-984 (MF-2 conformance audit R14b) — the always-run invariants that
 * read the registry read the whole store, not the frozen segment.
 *
 * ## Why
 *
 * After MF-2, `findings.jsonl` holds the genesis segment only. A finding born
 * after the freeze is a `CREATED` event in `findings/<PREFIX>/<ID>.jsonl`, and
 * an `AMENDED` event rewrites what a legacy row says. Two always-run specs
 * still took their rows from the frozen file:
 *
 *   - finding-id-aliases.spec.ts judges every alias against the genesis ids
 *     alone: an alias whose canonical id is an event-born finding fails
 *     "every alias resolves", and an alias spelled like an event-born id
 *     passes "no alias shadows a real ledger id".
 *   - finding-evidence-shape.spec.ts holds genesis rows to the canonical
 *     evidence shape: a finding born after the freeze, or one whose evidence an
 *     AMENDED event rewrote, is never held to it (only the write-time sink is).
 *
 * The projection (`readRegistryRows`) is the one reader that folds both, so
 * the specs read through it.
 *
 * ## What these tests pin
 *
 * Each runs the real spec (a copy resolves its repository root to the
 * fixture) on a throwaway repository whose store holds an event-born finding:
 *
 *   - an alias to an event-born id resolves, and the spec has no failing test;
 *   - an alias spelled like an event-born id is caught as a shadow;
 *   - an event-born row with non-canonical evidence is flagged, and so is a
 *     legacy row whose evidence an AMENDED event rewrote non-canonical.
 *
 * Each group opens with a control run on the same fixture with nothing wrong,
 * and counts only the tests that fail in addition to it, so a failure that is
 * the fixture's cancels out.
 */
import {
  createdPayload,
  EVENT_STORE_RELATIVE_DIR,
  eventFilePath,
  nextEvent,
  serializeEvents,
} from './helpers/finding-event-fixture';
import {
  type CliRun,
  FIXTURE_ALIAS_REVIEW_FILE,
  fixtureFinding,
  parseJsonlRows,
  REGISTRY_RELATIVE_PATH,
  RegistryFixtureRepo,
} from './helpers/registry-fixture-repo';
import {
  failedTests,
  installSpec,
  newlyFailing,
  runSpecIn,
  type SpecRun,
} from './helpers/spec-in-fixture';

const SLOW_TEST_MS = 600_000;
const AT = '2026-10-25T00:00:00Z';
const LEGACY = 'ARIA-HIGH-901';
const LEGACY_OTHER = 'ARIA-HIGH-902';
const BORN = 'ARIA-HIGH-905';
const NON_CANONICAL_EVIDENCE = 'droplet diagnostic: disk at 91 percent';

function expectOk(run: CliRun): void {
  expect({ status: run.status, stderr: run.status === 0 ? '' : run.stderr }).toEqual({
    status: 0,
    stderr: '',
  });
}

function tip(repo: RegistryFixtureRepo): string {
  const rows = parseJsonlRows(repo.read(REGISTRY_RELATIVE_PATH));
  return rows[rows.length - 1]?.content_hash ?? '';
}

function legacyHash(repo: RegistryFixtureRepo, id: string): string {
  const row = parseJsonlRows(repo.read(REGISTRY_RELATIVE_PATH)).find((entry) => entry.id === id);
  if (row === undefined) throw new Error(`${id} is not in the fixture registry`);
  return row.content_hash;
}

/** A finding born after the freeze: one CREATED event anchored on the genesis tip. */
function bear(
  repo: RegistryFixtureRepo,
  id: string,
  overrides: Parameters<typeof fixtureFinding>[1] = {},
): void {
  const created = nextEvent(id, [], tip(repo), {
    event_type: 'CREATED',
    payload: createdPayload(fixtureFinding(id, overrides)),
    reason: null,
    occurred_at: AT,
  });
  repo.write(eventFilePath(id), serializeEvents([created]));
}

/** A frozen registry with two legacy findings and one born after the freeze, committed; returns the head sha. */
function seedFrozenStore(repo: RegistryFixtureRepo): string {
  repo.writeRegistry([fixtureFinding(LEGACY), fixtureFinding(LEGACY_OTHER)]);
  repo.commit('chore(registry): seed the legacy registry', '2026-10-01T10:00:00Z');
  const pinned = repo.registry(['genesis']);
  expectOk(pinned);
  bear(repo, BORN);
  return repo.commit('chore(registry): freeze and record a finding', '2026-10-02T10:00:00Z');
}

function failureText(run: SpecRun): string {
  return failedTests(run)
    .map((test) => `${test.name}\n${test.message}`)
    .join('\n');
}

describe('ARIA-MEDIUM-984 - the alias sidecar spec judges aliases against the born findings too', () => {
  const SPEC = 'finding-id-aliases.spec.ts';
  const repo = RegistryFixtureRepo.create('mf2-alias-born-');
  const ALIAS = 'ARIA-HIGH-950';
  let seed = '';
  let control: SpecRun;

  /** One alias of the sidecar, with the audit evidence the spec requires of every alias. */
  const alias = (aliasId: string, canonical: string): void => {
    repo.write(
      FIXTURE_ALIAS_REVIEW_FILE,
      `# alias fixture review\n\n## ${aliasId} - an aliased id\n`,
    );
    repo.writeAliases([
      { alias: aliasId, canonical, review_file: FIXTURE_ALIAS_REVIEW_FILE, commits: [seed] },
    ]);
  };

  beforeAll(() => {
    installSpec(repo, SPEC);
    seed = seedFrozenStore(repo);
    alias(ALIAS, LEGACY);
    control = runSpecIn(repo, SPEC);
  }, SLOW_TEST_MS);

  afterAll(() => repo.dispose());

  it(
    'the control: the alias spec has no failing test when the alias names a legacy finding',
    () => {
      expect(control.tests.length).toBeGreaterThan(0);
      expect(failedTests(control).map((test) => `${test.name}\n${test.message}`)).toEqual([]);
    },
    SLOW_TEST_MS,
  );

  it(
    'an alias whose canonical id is a finding born after the freeze resolves',
    () => {
      alias(ALIAS, BORN);
      const run = runSpecIn(repo, SPEC);
      expect(run.tests.length).toBe(control.tests.length);
      expect(failedTests(run).map((test) => `${test.name}\n${test.message}`)).toEqual([]);
    },
    SLOW_TEST_MS,
  );

  it(
    'an alias spelled like a finding born after the freeze is caught as a shadow',
    () => {
      alias(BORN, LEGACY);
      const run = runSpecIn(repo, SPEC);
      expect(run.tests.length).toBe(control.tests.length);
      expect(newlyFailing(control, run).length).toBeGreaterThan(0);
      expect(failureText(run)).toContain(BORN);
    },
    SLOW_TEST_MS,
  );
});

describe('ARIA-MEDIUM-984 - the evidence-shape spec holds born findings and amended evidence to the canonical shape', () => {
  const SPEC = 'finding-evidence-shape.spec.ts';
  const repo = RegistryFixtureRepo.create('mf2-evidence-born-');
  const BORN_BAD = 'ARIA-HIGH-906';
  let control: SpecRun;

  beforeAll(() => {
    installSpec(repo, SPEC);
    seedFrozenStore(repo);
    control = runSpecIn(repo, SPEC);
  }, SLOW_TEST_MS);

  /** What a test wrote into the store, so the next one starts from the committed freeze. */
  afterEach(() => repo.git(['clean', '-fdq', '--', EVENT_STORE_RELATIVE_DIR]));
  afterAll(() => repo.dispose());

  it(
    'the control: the spec has no failing test when every row holds canonical evidence',
    () => {
      expect(control.tests.length).toBeGreaterThan(0);
      expect(failedTests(control).map((test) => `${test.name}\n${test.message}`)).toEqual([]);
    },
    SLOW_TEST_MS,
  );

  it(
    'a finding born after the freeze with non-canonical evidence is flagged',
    () => {
      bear(repo, BORN_BAD, { evidence: [NON_CANONICAL_EVIDENCE] });
      const run = runSpecIn(repo, SPEC);
      expect(run.tests.length).toBe(control.tests.length);
      expect(newlyFailing(control, run).length).toBeGreaterThan(0);
      expect(failureText(run)).toContain(BORN_BAD);
    },
    SLOW_TEST_MS,
  );

  it(
    'a legacy finding whose evidence an AMENDED event rewrote non-canonical is flagged',
    () => {
      const amended = nextEvent(LEGACY_OTHER, [], legacyHash(repo, LEGACY_OTHER), {
        event_type: 'AMENDED',
        payload: { fields: { evidence: [NON_CANONICAL_EVIDENCE] } },
        reason: 'the evidence cited a diagnostic, not a path',
        occurred_at: AT,
      });
      repo.write(eventFilePath(LEGACY_OTHER), serializeEvents([amended]));
      const run = runSpecIn(repo, SPEC);
      expect(run.tests.length).toBe(control.tests.length);
      expect(newlyFailing(control, run).length).toBeGreaterThan(0);
      expect(failureText(run)).toContain(LEGACY_OTHER);
    },
    SLOW_TEST_MS,
  );
});
