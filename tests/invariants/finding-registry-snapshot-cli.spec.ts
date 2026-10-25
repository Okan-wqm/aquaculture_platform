/**
 * `finding-registry verify --ref` and `project --format=records` — the two CLI
 * modes the kernel's registry readers ask (MF-2 conformance audit R14b,
 * ARIA-MEDIUM-985 and ARIA-MEDIUM-962).
 *
 * ## Why
 *
 * The autonomy closure verdict claims "the registry at the evidence commit is
 * intact". Since MF-2 the registry is the frozen segment, its pin and one event
 * log per finding, and the closure projection folds those logs, so the verdict
 * is only as true as the check over all of them: `verify --ref=<rev>` judges
 * the whole registry as a commit stores it (the working tree is not read), as
 * one JSON line the kernel maps to its predicate. The registry view cites the
 * file that holds each finding it ingests: `project --format=records` hands
 * every row out with that file, so the kernel never learns the store layout.
 *
 * ## What these tests pin
 *
 *   - `verify --ref` passes a commit whose store verifies, and names a broken
 *     event log, a pin that does not match the segment, and an unreadable ref,
 *     each as `{ok:false}` with the reason and exit 1;
 *   - it reads the commit, not the working tree (a healthy tree does not hide a
 *     broken commit, a broken tree does not break a healthy commit);
 *   - a commit from before the freeze (no pin, no logs) is judged on its chain;
 *   - `project --format=records` names the event log for a finding that has
 *     one (born after the freeze, or amended since) and the frozen segment for
 *     the rest, and `--ids` selects.
 */
import { type Finding } from '../../tools/gates/finding-registry-chain';

import {
  createdPayload,
  eventFilePath,
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

const SLOW_TEST_MS = 600_000;
const AT = '2026-10-25T00:00:00Z';
const LEGACY = 'ARIA-HIGH-901';
const AMENDED = 'ARIA-HIGH-902';
const BORN = 'ARIA-HIGH-905';

interface Verdict {
  readonly ok: boolean;
  readonly entries: number;
  readonly event_logs: number;
  readonly reason: string | null;
  readonly tip: string | null;
}

function verdictOf(run: CliRun): Verdict {
  const lines = run.stdout.split('\n').filter((line) => line.trim() !== '');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? '') as Verdict;
}

function rowHash(repo: RegistryFixtureRepo, id: string): string {
  const row = parseJsonlRows(repo.read(REGISTRY_RELATIVE_PATH)).find((entry) => entry.id === id);
  if (row === undefined) throw new Error(`${id} is not in the fixture registry`);
  return row.content_hash;
}

function tip(repo: RegistryFixtureRepo): string {
  const rows = parseJsonlRows(repo.read(REGISTRY_RELATIVE_PATH));
  return rows[rows.length - 1]?.content_hash ?? '';
}

/** A finding born after the freeze: one CREATED line anchored on the genesis tip. */
function bear(repo: RegistryFixtureRepo, id: string, overrides: Partial<Finding> = {}): void {
  const created = nextEvent(id, [], tip(repo), {
    event_type: 'CREATED',
    payload: createdPayload(fixtureFinding(id, overrides)),
    reason: null,
    occurred_at: AT,
  });
  repo.write(eventFilePath(id), serializeEvents([created]));
}

/** A legacy finding's first event: STATE_TRANSITIONED, anchored on its genesis row. */
function stale(repo: RegistryFixtureRepo, id: string): void {
  const event = nextEvent(id, [], rowHash(repo, id), {
    event_type: 'STATE_TRANSITIONED',
    payload: transition('OPEN', 'STALE'),
    reason: 'the plan it belonged to moved',
    occurred_at: AT,
  });
  repo.write(eventFilePath(id), serializeEvents([event]));
}

describe('finding-registry verify --ref - the whole registry as a commit stores it', () => {
  const repo = RegistryFixtureRepo.create('mf2-verify-ref-');
  let preFreeze = '';
  let healthy = '';
  let brokenLog = '';
  let stalePin = '';

  beforeAll(() => {
    repo.writeRegistry([fixtureFinding(LEGACY), fixtureFinding(AMENDED)]);
    preFreeze = repo.commit('chore(registry): seed the legacy registry', '2026-10-01T10:00:00Z');
    expect(repo.registry(['genesis']).status).toBe(0);
    bear(repo, BORN);
    stale(repo, AMENDED);
    healthy = repo.commit(
      'chore(registry): freeze and record two findings',
      '2026-10-02T10:00:00Z',
    );

    // A commit whose born log carries a content hash its line does not match.
    const log = repo.read(eventFilePath(BORN));
    const line = JSON.parse(log) as Record<string, unknown>;
    repo.write(
      eventFilePath(BORN),
      `${JSON.stringify({ ...line, content_hash: '0'.repeat(64) })}\n`,
    );
    brokenLog = repo.commit('chore(registry): corrupt a log', '2026-10-03T10:00:00Z');

    // A commit whose segment moved without a re-pin.
    repo.git(['checkout', '-q', '-b', 'pinless', healthy]);
    repo.writeRegistry([
      fixtureFinding(LEGACY),
      fixtureFinding(AMENDED),
      fixtureFinding('ARIA-HIGH-906'),
    ]);
    stalePin = repo.commit('chore(registry): append a row, no re-pin', '2026-10-04T10:00:00Z');
    repo.git(['checkout', '-q', 'main']);
  }, SLOW_TEST_MS);

  afterAll(() => repo.dispose());

  it(
    'passes a commit whose store verifies, and says what it read',
    () => {
      const run = repo.registry(['verify', `--ref=${healthy}`]);
      expect(run.status).toBe(0);
      expect(verdictOf(run)).toMatchObject({
        ok: true,
        entries: 2,
        event_logs: 2,
        reason: null,
        tip: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    },
    SLOW_TEST_MS,
  );

  it(
    'names an event log of the commit whose hash does not match its line',
    () => {
      const run = repo.registry(['verify', `--ref=${brokenLog}`]);
      expect(run.status).toBe(1);
      const verdict = verdictOf(run);
      expect(verdict.ok).toBe(false);
      expect(verdict.tip).toBeNull();
      expect(verdict.reason).toContain(`${BORN}.jsonl:1: content_hash does not match the line`);
    },
    SLOW_TEST_MS,
  );

  it(
    'names a genesis pin that does not match the commit segment',
    () => {
      const run = repo.registry(['verify', `--ref=${stalePin}`]);
      expect(run.status).toBe(1);
      expect(verdictOf(run).reason).toContain('blob_sha256');
    },
    SLOW_TEST_MS,
  );

  it(
    'reads the commit, not the working tree',
    () => {
      // main holds the corrupt log: the working tree is broken, the healthy commit still verifies.
      expect(repo.registry(['verify']).status).toBe(1);
      expect(repo.registry(['verify', `--ref=${healthy}`]).status).toBe(0);
      // And the other way round: a healthy working tree does not hide a broken commit.
      try {
        repo.git(['checkout', '-q', healthy, '--', eventFilePath(BORN)]);
        expect(repo.registry(['verify']).status).toBe(0);
        expect(repo.registry(['verify', `--ref=${brokenLog}`]).status).toBe(1);
      } finally {
        repo.git(['checkout', '-q', '-f', 'main']);
      }
    },
    SLOW_TEST_MS,
  );

  it(
    'judges a commit from before the freeze (no pin, no logs) on its chain alone',
    () => {
      const run = repo.registry(['verify', `--ref=${preFreeze}`]);
      expect(run.status).toBe(0);
      expect(verdictOf(run)).toMatchObject({ ok: true, entries: 2, event_logs: 0 });
    },
    SLOW_TEST_MS,
  );

  it(
    'answers {ok:false} for a ref the repository does not hold',
    () => {
      const run = repo.registry(['verify', `--ref=${'f'.repeat(40)}`]);
      expect(run.status).toBe(1);
      const verdict = verdictOf(run);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain('registry_unreadable');
    },
    SLOW_TEST_MS,
  );
});

describe('finding-registry project --format=records - each row with the file that holds it', () => {
  const repo = RegistryFixtureRepo.create('mf2-records-');

  beforeAll(() => {
    repo.writeRegistry([fixtureFinding(LEGACY), fixtureFinding(AMENDED)]);
    repo.commit('chore(registry): seed the legacy registry', '2026-10-01T10:00:00Z');
    expect(repo.registry(['genesis']).status).toBe(0);
    bear(repo, BORN);
    stale(repo, AMENDED);
    repo.commit('chore(registry): freeze and record two findings', '2026-10-02T10:00:00Z');
  }, SLOW_TEST_MS);

  afterAll(() => repo.dispose());

  const records = (args: readonly string[] = []): { row: Finding; source: string }[] => {
    const run = repo.registry(['project', '--format=records', ...args]);
    expect(run.status).toBe(0);
    return run.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { row: Finding; source: string });
  };

  it(
    'names the event log for a finding that has one and the frozen segment for the rest',
    () => {
      const sources = Object.fromEntries(records().map((record) => [record.row.id, record.source]));
      expect(sources).toEqual({
        [LEGACY]: REGISTRY_RELATIVE_PATH,
        [AMENDED]: eventFilePath(AMENDED),
        [BORN]: eventFilePath(BORN),
      });
    },
    SLOW_TEST_MS,
  );

  it(
    'hands out the same rows as --format=jsonl',
    () => {
      const run = repo.project();
      expect(run.status).toBe(0);
      expect(records().map((record) => record.row)).toEqual(run.rows);
    },
    SLOW_TEST_MS,
  );

  it(
    'selects with --ids',
    () => {
      expect(records(['--ids', BORN]).map((record) => record.row.id)).toEqual([BORN]);
    },
    SLOW_TEST_MS,
  );
});
