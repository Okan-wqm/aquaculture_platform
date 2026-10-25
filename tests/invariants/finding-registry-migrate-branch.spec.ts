/**
 * MF-2 (MF-DESIGN §6 step 4) — a branch that wrote findings.jsonl before the
 * freeze is converted to events, deterministically, with no new id.
 *
 * ## Why
 *
 * When MF-2 lands, findings.jsonl becomes a frozen genesis segment and CI
 * refuses any branch whose copy differs from the pin. Branches opened before
 * the freeze (ARIA landing PRs, registration PRs) appended rows and edited
 * legacy rows in place. Re-entering those changes by hand is the slip the
 * registry exists to prevent, so `tools/gates/finding-registry-migrate-branch.ts`
 * replays them: it diffs the branch's findings.jsonl against the base, turns
 * each new row into a CREATED file and each changed legacy row into
 * AMENDED / OWNER_ASSIGNED / STATE_TRANSITIONED / CLOSURE_REJECTED events,
 * drops RESOLVED edits (the merged trailer derives them), and restores the
 * frozen blob. MF-3 retires the converter once no open PR touches
 * findings.jsonl.
 *
 * ## The fixture (a throwaway repository running the real CLIs)
 *
 *   - main: a commit whose trailer closes ARIA-HIGH-910, seven legacy rows
 *     (910 recorded RESOLVED by that commit, as legacy closures were), then a
 *     commit whose trailer closes ARIA-HIGH-905;
 *   - branch `in-flight`, forked there: a fix whose trailer closes
 *     ARIA-HIGH-904, then one registry commit that appends ARIA-HIGH-907
 *     (OPEN) and ARIA-MEDIUM-908 (IN-PROGRESS) and edits 901 (title), 902
 *     (owner and deadline filled), 903 (OPEN → IN-PROGRESS), 904 (recorded
 *     RESOLVED by hand), 905 (main's closer rejected) and 910 (reopened the
 *     way the pre-freeze `reopen --reject-closure` wrote it: closer moved to
 *     rejected_closing_commits, state OPEN, closed_at cleared, notes stamped);
 *     906 is untouched;
 *   - main freezes (`finding-registry genesis`), and the branch merges main —
 *     cleanly, since main changed genesis.json and the branch findings.jsonl.
 *
 * ## What these tests pin
 *
 *   - CI refuses the in-flight branch on the genesis pin and names the converter;
 *   - the converter restores the frozen blob and writes exactly the expected
 *     event files, each a valid chain anchored on genesis;
 *   - it is deterministic: a second run on the same tree writes the same bytes;
 *   - the projection after it holds every change the branch meant, with 904
 *     closed by its trailer, 905 and 910 reopened by their rejections (910
 *     with no STATE_TRANSITIONED: the rejection is what reopens it), and no
 *     new id;
 *   - the converted branch then merges into main with findings.jsonl untouched.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { type Finding } from '../../tools/gates/finding-registry-chain';

import {
  EVENT_STORE_RELATIVE_DIR,
  eventContentHash,
  eventFilePath,
  type FindingEventLine,
  parseEvents,
  UUID_SHAPE,
} from './helpers/finding-event-fixture';
import {
  type CliRun,
  closesTrailer,
  fixtureFinding,
  REGISTRY_RELATIVE_PATH,
  RegistryFixtureRepo,
} from './helpers/registry-fixture-repo';

const CLI_TEST_TIMEOUT_MS = 300_000;
const CONVERTER = 'tools/gates/finding-registry-migrate-branch.ts';

function expectOk(run: CliRun): void {
  expect({ status: run.status, stderr: run.status === 0 ? '' : run.stderr }).toEqual({
    status: 0,
    stderr: '',
  });
}

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

/** Every event file's bytes, keyed by path: what a second run must reproduce. */
function storeBytes(root: string): Record<string, string> {
  return Object.fromEntries(
    eventFiles(root).map((rel) => [rel, readFileSync(join(root, rel), 'utf8')]),
  );
}

function withoutContentHash(event: FindingEventLine): Omit<FindingEventLine, 'content_hash'> {
  return Object.fromEntries(
    Object.entries(event).filter(([key]) => key !== 'content_hash'),
  ) as Omit<FindingEventLine, 'content_hash'>;
}

const LEGACY_IDS = [
  'ARIA-HIGH-901',
  'ARIA-HIGH-902',
  'ARIA-HIGH-903',
  'ARIA-HIGH-904',
  'ARIA-HIGH-905',
  'ARIA-HIGH-906',
  'ARIA-HIGH-910',
] as const;

function legacyRows(closer910: string): Finding[] {
  return LEGACY_IDS.map((id) => {
    switch (id) {
      case 'ARIA-HIGH-902':
        return fixtureFinding(id, { owner_user: null, deadline: null });
      case 'ARIA-HIGH-910':
        return fixtureFinding(id, {
          deadline: '2099-12-31',
          state: 'RESOLVED',
          closing_commits: [closer910],
          closed_at: '2026-09-30T10:00:00.000Z',
        });
      default:
        return fixtureFinding(id, { deadline: '2099-12-31' });
    }
  });
}

/** The notes the pre-freeze `reopen --reject-closure` stamped on 910. */
const REOPEN_910_NOTES = ' [override reopen 2026-10-04: closer rejected — it did not fix 910]';

describe('MF-2 — finding-registry-migrate-branch converts an in-flight branch to events', () => {
  const repo = RegistryFixtureRepo.create('mf2-migrate-branch-');
  const shas = { closer905: '', closer910: '', fix904: '', freeze: '', merged: '' };
  let frozen = '';
  let verifyBefore: CliRun | undefined;
  let firstRun: CliRun | undefined;
  let firstStore: Record<string, string> = {};
  let firstRegistry = '';

  beforeAll(() => {
    shas.closer910 = repo.commit(
      `fix(fixture): close 910\n\n${closesTrailer('ARIA-HIGH-910')}`,
      '2026-09-30T10:00:00Z',
    );
    repo.writeRegistry(legacyRows(shas.closer910));
    repo.commit('chore(registry): seed the legacy registry', '2026-10-01T10:00:00Z');
    shas.closer905 = repo.commit(
      `fix(fixture): a first attempt at 905\n\n${closesTrailer('ARIA-HIGH-905')}`,
      '2026-10-02T10:00:00Z',
    );

    repo.git(['checkout', '-q', '-b', 'in-flight']);
    shas.fix904 = repo.commit(
      `fix(fixture): close 904\n\n${closesTrailer('ARIA-HIGH-904')}`,
      '2026-10-03T10:00:00Z',
    );
    const edited = legacyRows(shas.closer910).map((row): Finding => {
      switch (row.id) {
        case 'ARIA-HIGH-901':
          return { ...row, title: 'the title names the defect, not its symptom' };
        case 'ARIA-HIGH-902':
          return { ...row, owner_user: 'Okan-wqm', deadline: '2099-12-31' };
        case 'ARIA-HIGH-903':
          return { ...row, state: 'IN-PROGRESS' };
        case 'ARIA-HIGH-904':
          return {
            ...row,
            state: 'RESOLVED',
            closing_commits: [shas.fix904],
            closed_at: '2026-10-03T10:00:00.000Z',
          };
        case 'ARIA-HIGH-905':
          return { ...row, rejected_closing_commits: [shas.closer905] };
        case 'ARIA-HIGH-910':
          return {
            ...row,
            state: 'OPEN',
            closing_commits: [],
            closed_at: null,
            rejected_closing_commits: [shas.closer910],
            notes: REOPEN_910_NOTES,
          };
        default:
          return row;
      }
    });
    repo.writeRegistry([
      ...edited,
      fixtureFinding('ARIA-HIGH-907', { deadline: '2099-12-31' }),
      fixtureFinding('ARIA-MEDIUM-908', { state: 'IN-PROGRESS', deadline: '2099-12-31' }),
    ]);
    repo.commit('chore(findings): the branch records and edits findings', '2026-10-04T10:00:00Z');

    repo.git(['checkout', '-q', 'main']);
    frozen = repo.read(REGISTRY_RELATIVE_PATH);
    repo.registry(['genesis']);
    shas.freeze = repo.commit(
      'chore(registry): freeze findings.jsonl as the genesis segment',
      '2026-10-05T10:00:00Z',
    );

    repo.git(['checkout', '-q', 'in-flight']);
    shas.merged = repo.merge('main', '2026-10-06T10:00:00Z');
    verifyBefore = repo.registry(['verify']);

    firstRun = repo.gate(CONVERTER, ['--base=main']);
    firstStore = storeBytes(repo.root);
    firstRegistry = repo.read(REGISTRY_RELATIVE_PATH);
  }, CLI_TEST_TIMEOUT_MS);

  afterAll(() => repo.dispose());

  it('CI refuses the in-flight branch on the genesis pin and names the converter', () => {
    expect(verifyBefore?.status).toBe(1);
    expect(verifyBefore?.stderr).toContain('finding-registry-migrate-branch');
  });

  it('restores the frozen blob and writes exactly the expected event files', () => {
    expectOk(firstRun as CliRun);
    expect(firstRegistry).toBe(frozen);
    expect(Object.keys(firstStore)).toEqual(
      [
        'ARIA-HIGH-901',
        'ARIA-HIGH-902',
        'ARIA-HIGH-903',
        'ARIA-HIGH-905',
        'ARIA-HIGH-907',
        'ARIA-MEDIUM-908',
        'ARIA-HIGH-910',
      ]
        .map(eventFilePath)
        .sort(),
    );
    const only = (id: string): FindingEventLine => {
      const events = parseEvents(firstStore[eventFilePath(id)] ?? '');
      expect([id, events.length]).toEqual([id, 1]);
      return events[0] as FindingEventLine;
    };
    expect(only('ARIA-HIGH-901')).toMatchObject({
      event_type: 'AMENDED',
      payload: { fields: { title: 'the title names the defect, not its symptom' } },
    });
    expect(only('ARIA-HIGH-902')).toMatchObject({
      event_type: 'OWNER_ASSIGNED',
      payload: { owner_user: 'Okan-wqm', deadline: '2099-12-31' },
    });
    expect(only('ARIA-HIGH-903')).toMatchObject({
      event_type: 'STATE_TRANSITIONED',
      payload: { from_state: 'OPEN', to_state: 'IN-PROGRESS' },
    });
    expect(only('ARIA-HIGH-905')).toMatchObject({
      event_type: 'CLOSURE_REJECTED',
      payload: { shas: [shas.closer905] },
    });
    // The rejection reopens 910 in the fold; a transition after it would be
    // from a state the row is no longer in.
    expect(
      parseEvents(firstStore[eventFilePath('ARIA-HIGH-910')] ?? '').map((event) => ({
        event_type: event.event_type,
        payload: event.payload,
      })),
    ).toEqual([
      { event_type: 'CLOSURE_REJECTED', payload: { shas: [shas.closer910] } },
      { event_type: 'AMENDED', payload: { fields: { notes: REOPEN_910_NOTES } } },
    ]);
    expect(only('ARIA-HIGH-907')).toMatchObject({
      event_type: 'CREATED',
      reason: null,
      payload: { id: 'ARIA-HIGH-907', state: 'OPEN' },
    });
    expect(only('ARIA-MEDIUM-908')).toMatchObject({
      event_type: 'CREATED',
      reason: null,
      payload: { id: 'ARIA-MEDIUM-908', state: 'IN-PROGRESS' },
    });

    // Every line chains onto genesis: the legacy row, or the tip for a new id.
    const rows = new Map(
      frozen
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Finding)
        .map((row) => [row.id, row]),
    );
    const tip = [...rows.values()].pop()?.content_hash;
    const chainDefects = Object.entries(firstStore).flatMap(([rel, text]) => {
      const id = rel.slice(rel.lastIndexOf('/') + 1, -'.jsonl'.length);
      return parseEvents(text).flatMap((event, index) => {
        const where = `${rel}:${index + 1}`;
        const defects: string[] = [];
        if (event.finding_id !== id || event.version !== index + 1)
          defects.push(`${where}: identity`);
        if (index === 0 && event.prev_hash !== (rows.get(id)?.content_hash ?? tip)) {
          defects.push(`${where}: anchor`);
        }
        if (event.content_hash !== eventContentHash(withoutContentHash(event))) {
          defects.push(`${where}: content_hash`);
        }
        if (!UUID_SHAPE.test(event.event_id)) defects.push(`${where}: event_id`);
        if (event.event_type !== 'CREATED' && String(event.reason ?? '').trim() === '') {
          defects.push(`${where}: no reason`);
        }
        return defects;
      });
    });
    expect(chainDefects).toEqual([]);
    expectOk(repo.registry(['verify']));
  });

  it(
    'is deterministic: a second run on the same tree writes the same bytes',
    () => {
      expectOk(firstRun as CliRun);
      repo.git(['checkout', '-q', '-f', 'HEAD', '--', '.']);
      repo.git(['clean', '-fdq', '--', EVENT_STORE_RELATIVE_DIR]);
      expect(eventFiles(repo.root)).toEqual([]);
      expectOk(repo.gate(CONVERTER, ['--base=main']));
      expect(storeBytes(repo.root)).toEqual(firstStore);
      expect(repo.read(REGISTRY_RELATIVE_PATH)).toBe(firstRegistry);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'the projection holds every change the branch meant, with no new id',
    () => {
      expectOk(firstRun as CliRun);
      repo.commit('chore(findings): convert the branch registry to events', '2026-10-07T10:00:00Z');
      const run = repo.project();
      expectOk(run);
      const rows = new Map(run.rows.map((row) => [row.id, row]));
      expect([...rows.keys()].sort()).toEqual(
        [...LEGACY_IDS, 'ARIA-HIGH-907', 'ARIA-MEDIUM-908'].sort(),
      );
      expect(rows.get('ARIA-HIGH-901')?.title).toBe('the title names the defect, not its symptom');
      expect(rows.get('ARIA-HIGH-902')).toMatchObject({
        owner_user: 'Okan-wqm',
        deadline: '2099-12-31',
      });
      expect(rows.get('ARIA-HIGH-903')?.state).toBe('IN-PROGRESS');
      // The RESOLVED edit was dropped; the merged trailer closes 904.
      expect(rows.get('ARIA-HIGH-904')).toMatchObject({
        state: 'RESOLVED',
        closing_commits: [shas.fix904],
      });
      expect(rows.get('ARIA-HIGH-905')).toMatchObject({
        state: 'OPEN',
        rejected_closing_commits: [shas.closer905],
      });
      expect(rows.get('ARIA-HIGH-906')?.state).toBe('OPEN');
      expect(rows.get('ARIA-HIGH-910')).toMatchObject({
        state: 'OPEN',
        closing_commits: [],
        closed_at: null,
        rejected_closing_commits: [shas.closer910],
        notes: REOPEN_910_NOTES,
      });
      expect(rows.get('ARIA-HIGH-907')?.state).toBe('OPEN');
      expect(rows.get('ARIA-MEDIUM-908')?.state).toBe('IN-PROGRESS');
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'the converted branch merges into main with findings.jsonl untouched',
    () => {
      repo.git(['checkout', '-q', 'main']);
      repo.merge('in-flight', '2026-10-08T10:00:00Z');
      expect(repo.read(REGISTRY_RELATIVE_PATH)).toBe(frozen);
      expect(
        repo.git(['diff', '--name-only', shas.freeze, 'HEAD', '--', REGISTRY_RELATIVE_PATH]),
      ).toBe('');
      expectOk(repo.registry(['verify']));
    },
    CLI_TEST_TIMEOUT_MS,
  );
});
