/**
 * ARIA-HIGH-983 (MF-2 conformance audit R8) — once the base carries the
 * freeze, no branch moves the frozen segment, and every always-run check says so.
 *
 * ## Why
 *
 * MF-DESIGN §4.3 makes findings.jsonl a frozen genesis segment: "any byte
 * change to the file is red". The one place that holds `genesis.json` to the
 * base is `verify --base`, which runs in the Closes Footer Check, and that
 * check is not a required status context. The always-run integrity spec holds
 * only the event logs to the base. A branch that appends a row to
 * findings.jsonl, runs the remedy the pin failure names (`npm run
 * findings:genesis`) and commits the new pin therefore passes every required
 * check, and the frozen segment moves. A rule enforced only where nothing
 * requires it is not enforced.
 *
 * ## What these tests pin
 *
 * Each test builds a throwaway repository whose base (`main`, mirrored as
 * `origin/main`) is frozen, then a branch that moves the segment, and runs the
 * real integrity spec (a copy of tests/invariants/finding-registry-integrity.spec.ts
 * resolves its repository root to the fixture) and the real CLI on it:
 *
 *   - a branch that appends a row and commits a matching pin, and a branch
 *     that rewrites the last frozen row and commits a matching pin, each make
 *     the integrity spec fail; the same spec on a branch that only appends an
 *     event has no failing test (so the failure is the freeze, not the fixture);
 *   - `finding-registry genesis` refuses to re-pin when the base already
 *     holds a pin, and leaves genesis.json as it was;
 *   - the message for a post-freeze mismatch does not offer the re-pin, in the
 *     CLI's `verify` and in the integrity spec;
 *   - the cutover itself stays possible: when the base has no genesis.json,
 *     the re-pin is still the landing step, still named, and the integrity
 *     spec holds the cutover branch to nothing it cannot satisfy.
 */
import { type Finding } from '../../tools/gates/finding-registry-chain';
import { genesisPin, serializeGenesisPin } from '../../tools/gates/finding-registry-events';
import { LEGACY_OWNER_SPELLINGS } from '../../tools/gates/finding-registry-owners';

import {
  eventFilePath,
  GENESIS_RELATIVE_PATH,
  nextEvent,
  serializeEvents,
  transition,
} from './helpers/finding-event-fixture';
import {
  type CliRun,
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

const INTEGRITY_SPEC = 'finding-registry-integrity.spec.ts';
const SLOW_TEST_MS = 600_000;
const AT = '2026-10-25T00:00:00Z';
const RE_PIN_COMMAND = 'npm run findings:genesis';

function expectOk(run: CliRun): void {
  expect({ status: run.status, stderr: run.status === 0 ? '' : run.stderr }).toEqual({
    status: 0,
    stderr: '',
  });
}

/** Legacy rows, one per owner spelling the integrity spec requires to occur, then ordinary rows. */
function legacyRows(): Finding[] {
  return [
    fixtureFinding('ARIA-HIGH-901'),
    fixtureFinding('ARIA-HIGH-902'),
    fixtureFinding('ARIA-MEDIUM-903'),
    ...LEGACY_OWNER_SPELLINGS.map((owner, index) =>
      fixtureFinding(`ARIA-LOW-${911 + index}`, { owner_user: owner }),
    ),
  ];
}

/** Write a STATE_TRANSITIONED log for a genesis finding, anchored on that row. */
function stale(repo: RegistryFixtureRepo, id: string): void {
  const row = parseJsonlRows(repo.read(REGISTRY_RELATIVE_PATH)).find((entry) => entry.id === id);
  if (row === undefined) throw new Error(`${id} is not in the fixture registry`);
  const event = nextEvent(id, [], row.content_hash, {
    event_type: 'STATE_TRANSITIONED',
    payload: transition('OPEN', 'STALE'),
    reason: 'the plan it belonged to moved',
    occurred_at: AT,
  });
  repo.write(eventFilePath(id), serializeEvents([event]));
}

/** The pin the `genesis` command writes for the segment as it stands, written without the command. */
function pinSegment(repo: RegistryFixtureRepo): void {
  repo.write(
    GENESIS_RELATIVE_PATH,
    serializeGenesisPin(genesisPin(Buffer.from(repo.read(REGISTRY_RELATIVE_PATH), 'utf8'))),
  );
}

function failureText(run: SpecRun): string {
  return failedTests(run)
    .map((test) => `${test.name}\n${test.message}`)
    .join('\n');
}

describe('ARIA-HIGH-983 - a branch cannot move a segment its base already froze', () => {
  const repo = RegistryFixtureRepo.create('mf2-freeze-base-');
  const rows = legacyRows();
  let main = '';
  let healthy: SpecRun;

  beforeAll(() => {
    installSpec(repo, INTEGRITY_SPEC);
    repo.writeRegistry(rows);
    repo.commit('chore(registry): seed the legacy registry', '2026-10-01T10:00:00Z');
    const pinned = repo.registry(['genesis']);
    expectOk(pinned);
    stale(repo, 'ARIA-HIGH-902');
    main = repo.commit('chore(registry): freeze findings.jsonl', '2026-10-02T10:00:00Z');
    repo.git(['update-ref', 'refs/remotes/origin/main', main]);

    // The control: a branch that records one more decision as an event and nothing else.
    repo.git(['checkout', '-q', '-b', 'honest', main]);
    stale(repo, 'ARIA-MEDIUM-903');
    repo.commit('chore(registry): record a decision as an event', '2026-10-03T10:00:00Z');
    healthy = runSpecIn(repo, INTEGRITY_SPEC);
    repo.git(['checkout', '-q', 'main']);
  }, SLOW_TEST_MS);

  afterAll(() => repo.dispose());

  /** A branch off the frozen base whose first commit appends a legacy-shaped row to findings.jsonl. */
  function branchAppendingARow(name: string): void {
    repo.git(['checkout', '-q', '-b', name, main]);
    repo.writeRegistry([...rows, fixtureFinding('ARIA-HIGH-906')]);
  }

  it(
    'the control: the integrity spec has no failing test on a branch that only appends an event',
    () => {
      expect(healthy.tests.length).toBeGreaterThan(0);
      expect(failedTests(healthy).map((test) => test.name)).toEqual([]);
    },
    SLOW_TEST_MS,
  );

  it(
    'the integrity spec fails on a branch that appended a row to findings.jsonl and committed the matching pin',
    () => {
      branchAppendingARow('append-and-repin');
      pinSegment(repo);
      repo.commit('chore(registry): append a row and re-pin', '2026-10-03T11:00:00Z');
      const run = runSpecIn(repo, INTEGRITY_SPEC);
      repo.git(['checkout', '-q', 'main']);
      expect(run.tests.length).toBe(healthy.tests.length);
      expect(newlyFailing(healthy, run).length).toBeGreaterThan(0);
    },
    SLOW_TEST_MS,
  );

  it(
    'the integrity spec fails on a branch that rewrote the last frozen row and committed the matching pin',
    () => {
      repo.git(['checkout', '-q', '-b', 'rewrite-and-repin', main]);
      const frozen = rows.slice();
      const last = frozen[frozen.length - 1];
      if (last === undefined) throw new Error('the fixture registry is empty');
      frozen[frozen.length - 1] = { ...last, title: 'a frozen row, rewritten' };
      repo.writeRegistry(frozen);
      pinSegment(repo);
      repo.commit('chore(registry): rewrite a frozen row and re-pin', '2026-10-03T12:00:00Z');
      const run = runSpecIn(repo, INTEGRITY_SPEC);
      repo.git(['checkout', '-q', 'main']);
      expect(run.tests.length).toBe(healthy.tests.length);
      expect(newlyFailing(healthy, run).length).toBeGreaterThan(0);
    },
    SLOW_TEST_MS,
  );

  it(
    'finding-registry genesis refuses to re-pin when the base holds a pin, and leaves genesis.json as it was',
    () => {
      branchAppendingARow('append-then-genesis');
      const before = repo.read(GENESIS_RELATIVE_PATH);
      const run = repo.registry(['genesis']);
      const after = repo.read(GENESIS_RELATIVE_PATH);
      // Drop the uncommitted rows and pin so the next test starts from the base.
      repo.git(['checkout', '-q', '-f', 'main']);
      expect({ exit: run.status === 0 ? 'zero' : 'refused', pinChanged: after !== before }).toEqual(
        {
          exit: 'refused',
          pinChanged: false,
        },
      );
    },
    SLOW_TEST_MS,
  );

  /** A branch off the frozen base that appended a row to findings.jsonl and did not re-pin. */
  function branchWithAStalePin(name: string): void {
    repo.git(['checkout', '-q', '-b', name, main]);
    repo.writeRegistry([...rows, fixtureFinding('ARIA-HIGH-906')]);
    repo.commit('chore(registry): append a row, no re-pin', '2026-10-03T13:00:00Z');
  }

  it(
    'a post-freeze mismatch does not offer the re-pin in `verify`',
    () => {
      branchWithAStalePin('stale-pin-verify');
      const verified = repo.registry(['verify']);
      repo.git(['checkout', '-q', 'main']);
      // The premise: the branch is rejected, so the message is the one a contributor reads.
      expect(verified.status).toBe(1);
      expect(`${verified.stdout}${verified.stderr}`).not.toContain(RE_PIN_COMMAND);
    },
    SLOW_TEST_MS,
  );

  it(
    'a post-freeze mismatch does not offer the re-pin in the integrity spec',
    () => {
      branchWithAStalePin('stale-pin-spec');
      const run = runSpecIn(repo, INTEGRITY_SPEC);
      repo.git(['checkout', '-q', 'main']);
      expect(newlyFailing(healthy, run).length).toBeGreaterThan(0);
      expect(failureText(run)).not.toContain(RE_PIN_COMMAND);
    },
    SLOW_TEST_MS,
  );
});

describe('ARIA-HIGH-983 - the cutover stays possible: a base with no genesis.json is exempt', () => {
  const repo = RegistryFixtureRepo.create('mf2-freeze-cutover-');
  const rows = legacyRows();

  beforeAll(() => {
    installSpec(repo, INTEGRITY_SPEC);
  });

  afterAll(() => repo.dispose());

  it(
    'a branch that freezes the registry and merges a legacy row from main re-pins with the named command, and the integrity spec has no failing test on it',
    () => {
      repo.writeRegistry(rows);
      repo.commit('chore(registry): seed the legacy registry', '2026-10-01T10:00:00Z');

      // The branch freezes the registry and records a decision as an event.
      repo.git(['checkout', '-q', '-b', 'cutover']);
      const pinned = repo.registry(['genesis']);
      expectOk(pinned);
      stale(repo, 'ARIA-HIGH-902');
      repo.commit('chore(registry): freeze the segment', '2026-10-02T10:00:00Z');

      // main, before the freeze, takes a legacy row from the old writers.
      repo.git(['checkout', '-q', 'main']);
      repo.writeRegistry([...rows, fixtureFinding('ARIA-HIGH-907')]);
      const upstream = repo.commit('chore(registry): a legacy row lands', '2026-10-03T10:00:00Z');
      repo.git(['update-ref', 'refs/remotes/origin/main', upstream]);

      repo.git(['checkout', '-q', 'cutover']);
      repo.merge('main', '2026-10-04T10:00:00Z');

      // The pin is stale; the message names the landing step because no base holds a pin.
      const stalePin = repo.registry(['verify']);
      expect(stalePin.status).toBe(1);
      expect(`${stalePin.stdout}${stalePin.stderr}`).toContain(RE_PIN_COMMAND);

      const landing = repo.registry(['genesis']);
      expectOk(landing);
      repo.commit('chore(registry): re-pin after merging main', '2026-10-04T11:00:00Z');
      const verified = repo.registry(['verify']);
      expectOk(verified);

      const run = runSpecIn(repo, INTEGRITY_SPEC);
      expect(run.tests.length).toBeGreaterThan(0);
      expect(failedTests(run).map((test) => `${test.name}\n${test.message}`)).toEqual([]);
    },
    SLOW_TEST_MS,
  );
});
