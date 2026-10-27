/**
 * MF-2 (MF-DESIGN §4.1–§4.5, §7 T5) — every registry writer appends an event to
 * the finding's own file; findings.jsonl is frozen; the vocabulary cannot
 * express RESOLVED.
 *
 * ## Why
 *
 * After MF-1 nothing writes RESOLVED, but `add`, `assign`, `sweep`, `reopen`
 * and `canonicalize-owner` still wrote findings.jsonl: a new finding at the
 * end of one file, an edit by rewriting a past row and rechaining everything
 * after it. Two branches that each recorded a finding therefore conflicted on
 * GitHub, which runs no merge driver (141 conflicted syncs in 14 days,
 * MF-DESIGN §1). In the event store a writer appends one line to
 * `findings/<PREFIX>/<ID>.jsonl`, so two findings are two paths and only a
 * real same-finding race conflicts.
 *
 * ## What these tests pin
 *
 *   - T5: the event schema refuses `to_state: RESOLVED` and a CREATED row
 *     registered RESOLVED, and accepts each event of the closed vocabulary;
 *     `GitStateTarget` is exactly the four non-RESOLVED states (a compile-time
 *     `Equals<…>`, checked by tsc); the CLI has no `close`, `reconcile`,
 *     `rechain-from` or `dedupe`.
 *   - `finding-registry genesis` writes genesis.json from the frozen blob
 *     (blob sha256, entry count, tip content_hash), byte-identically on a rerun;
 *     the landing step reruns it as `npm run findings:genesis`.
 *   - The writers, through the real CLI of a throwaway repository: `add`
 *     creates the finding's file with one CREATED event anchored on the
 *     genesis tip and refuses a stub registered RESOLVED; `assign` and `sweep`
 *     append OWNER_ASSIGNED / STATE_TRANSITIONED anchored on the genesis row;
 *     findings.jsonl stays byte-identical; `project` reads the result.
 *   - T7, the implementation half: `verify --base=<rev>` refuses an event file
 *     that is not a byte-prefix extension of itself at the base and a deleted
 *     one, passes a pure append, and refuses a genesis segment rewritten and
 *     re-pinned (the freeze is final).
 *   - The corrupt store: `verify`, `project` and the writer's sink each name
 *     one defect written over a store that verifies (a version gap, a tampered
 *     or unchained line, a payload outside the event contract, a misplaced
 *     CREATED, a duplicated event id, and each refusal of the fold), so a
 *     check deleted from the verifier, the fold or the schema fails here.
 *   - The landing step: `finding-registry genesis` re-anchors the logs of
 *     findings born on a branch when a merge of main moves the genesis tip.
 *   - One event vocabulary: the Postgres ledger mirrors the git event (its
 *     bootstrap and parity read the projection, never the frozen file), and
 *     the ledger's own vocabulary (EVIDENCE_ADDED …) is gone from live code.
 *   - MF-3's retirement of the branch converter is a tracked finding,
 *     recorded through the event writer.
 *
 * The event line format is the one helpers/finding-event-fixture.ts documents.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import {
  canonicalJson,
  type Finding,
  type FindingState,
  sha256hex,
} from '../../tools/gates/finding-registry-chain';
import {
  appendFindingEvents,
  type FindingEventDraft,
  type GitStateTarget,
} from '../../tools/gates/finding-registry-events';
import { registryLayout } from '../../tools/gates/finding-registry-projection';
import { RegistryWriteRefused } from '../../tools/gates/finding-registry-rows';
import { withRegistryFileLock } from '../../tools/gates/finding-registry-store';

import {
  createdPayload,
  EVENT_FIELDS,
  EVENT_SCHEMA_RELATIVE_PATH,
  EVENT_STORE_RELATIVE_DIR,
  eventContentHash,
  eventFilePath,
  type FindingEventLine,
  GENESIS_RELATIVE_PATH,
  GIT_FINDING_EVENT_TYPES,
  nextEvent,
  parseEvents,
  serializeEvents,
  transition,
  UUID_SHAPE,
} from './helpers/finding-event-fixture';
import {
  type CliRun,
  fixtureFinding,
  FIXTURE_REVIEW_FILE,
  REGISTRY_RELATIVE_PATH,
  REPO_ROOT,
  RegistryFixtureRepo,
} from './helpers/registry-fixture-repo';

const CLI_TEST_TIMEOUT_MS = 300_000;
const ROW_SCHEMA_RELATIVE_PATH = 'docs/reviews/_registry/findings.jsonl.schema.json';

/** `A` and `B` are the same type (the strict form: no `any` leaks through). */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * Compile-time: a RESOLVED write is a type error at every writer
 * (MF-DESIGN §4.2). `tsc` rejects this line unless GitStateTarget is exactly
 * the four non-RESOLVED states.
 */
const GIT_STATE_TARGET_EXCLUDES_RESOLVED: Equals<
  GitStateTarget,
  Exclude<FindingState, 'RESOLVED'>
> = true;

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function expectOk(run: CliRun): void {
  expect({ status: run.status, stderr: run.status === 0 ? '' : run.stderr }).toEqual({
    status: 0,
    stderr: '',
  });
}

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

function readEvents(root: string, rel: string): FindingEventLine[] {
  return parseEvents(readFileSync(join(root, rel), 'utf8'));
}

/** The event without its own hash: the input of `content_hash`. */
function withoutContentHash(
  event: FindingEventLine | undefined,
): Omit<FindingEventLine, 'content_hash'> {
  if (event === undefined) throw new Error('no event to rehash');
  return Object.fromEntries(
    Object.entries(event).filter(([key]) => key !== 'content_hash'),
  ) as Omit<FindingEventLine, 'content_hash'>;
}

function lastRowHash(registryText: string): string {
  const lines = registryText.trim().split('\n');
  return (JSON.parse(lines[lines.length - 1] ?? '{}') as { content_hash: string }).content_hash;
}

function rowHash(registryText: string, id: string): string {
  const row = registryText
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Finding)
    .find((entry) => entry.id === id);
  if (row === undefined) throw new Error(`${id} is not in the genesis segment`);
  return row.content_hash;
}

function compileEventSchema(): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(JSON.parse(readFileSync(join(REPO_ROOT, ROW_SCHEMA_RELATIVE_PATH), 'utf8')));
  return ajv.compile(JSON.parse(readFileSync(join(REPO_ROOT, EVENT_SCHEMA_RELATIVE_PATH), 'utf8')));
}

const ANCHOR = 'b'.repeat(64);
const AT = '2026-10-25T00:00:00Z';

/** One valid event of each type of the closed vocabulary. */
function vocabularySamples(): FindingEventLine[] {
  const id = 'ARIA-HIGH-901';
  const created = nextEvent(id, [], ANCHOR, {
    event_type: 'CREATED',
    payload: createdPayload(fixtureFinding(id)),
    reason: null,
    occurred_at: AT,
  });
  const later = (
    event_type: FindingEventLine['event_type'],
    payload: Record<string, unknown>,
  ): FindingEventLine =>
    nextEvent(id, [created], ANCHOR, {
      event_type,
      payload,
      reason: `a reason for ${event_type}`,
      occurred_at: AT,
    });
  return [
    created,
    later('STATE_TRANSITIONED', transition('OPEN', 'STALE')),
    later('CLOSURE_REJECTED', { shas: ['a'.repeat(40)] }),
    later('OWNER_ASSIGNED', { owner_user: 'Okan-wqm', deadline: '2099-12-31' }),
    later('AMENDED', { fields: { title: 'the title names the defect' } }),
    later('SUPERSEDED', { successor_finding_id: 'ARIA-HIGH-902' }),
  ];
}

describe('MF-2 T5 — the event vocabulary cannot express RESOLVED', () => {
  it('the event schema refuses RESOLVED and accepts the closed vocabulary; GitStateTarget excludes RESOLVED', () => {
    expect(GIT_STATE_TARGET_EXCLUDES_RESOLVED).toBe(true);
    expect(existsSync(join(REPO_ROOT, EVENT_SCHEMA_RELATIVE_PATH))).toBe(true);
    const validate = compileEventSchema();
    // A boolean, not Ajv's type guard: a refused sample must keep its type.
    const accepts = (value: unknown): boolean => validate(value) === true;

    const samples = vocabularySamples();
    expect(samples.map((event) => event.event_type)).toEqual([...GIT_FINDING_EVENT_TYPES]);
    const refusedValid = samples.flatMap((event): string[] =>
      accepts(event) ? [] : [`${event.event_type}: ${JSON.stringify(validate.errors)}`],
    );
    expect(refusedValid).toEqual([]);

    const [created, transitioned] = samples as [FindingEventLine, FindingEventLine];
    const invalid: Record<string, unknown> = {
      'STATE_TRANSITIONED to RESOLVED': {
        ...transitioned,
        payload: { from_state: 'OPEN', to_state: 'RESOLVED' },
      },
      'CREATED as RESOLVED': {
        ...created,
        payload: {
          ...created.payload,
          state: 'RESOLVED',
          closing_commits: ['a'.repeat(40)],
          closed_at: AT,
        },
      },
      'RESOLVED as an event type': { ...transitioned, event_type: 'RESOLVED' },
      'the Postgres ledger vocabulary': {
        ...transitioned,
        event_type: 'EVIDENCE_ADDED',
        payload: { evidence: ['a.ts'] },
      },
      'a non-CREATED event without a reason': { ...transitioned, reason: null },
      'a field outside the line contract': { ...transitioned, main_sha: 'a'.repeat(40) },
    };
    const accepted = Object.entries(invalid)
      .filter(([, event]) => accepts(event))
      .map(([name]) => name);
    expect(accepted).toEqual([]);
  });

  it(
    'the CLI exposes no close, reconcile, rechain-from or dedupe',
    () => {
      const repo = RegistryFixtureRepo.create('mf2-cli-surface-');
      try {
        repo.writeRegistry([fixtureFinding('ARIA-HIGH-901')]);
        repo.commit('chore(registry): seed', '2026-10-01T10:00:00Z');
        const surviving = (
          [
            ['close', 'ARIA-HIGH-901'],
            ['reconcile', '--dry-run'],
            ['rechain-from', '0'],
            ['dedupe', '--dry-run'],
          ] as const
        )
          .map(([sub, arg]) => ({ sub, run: repo.registry([sub, arg]) }))
          .filter(
            ({ sub, run }) =>
              !(run.status === 2 && run.stderr.includes(`Unknown subcommand: ${sub}`)),
          )
          .map(({ sub, run }) => `${sub}: exit ${run.status}`);
        expect(surviving).toEqual([]);
      } finally {
        repo.dispose();
      }
    },
    CLI_TEST_TIMEOUT_MS,
  );
});

describe('MF-2 — the writers append per-finding events and findings.jsonl is frozen', () => {
  const repo = RegistryFixtureRepo.create('mf2-event-writers-');
  const stub = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      severity: 'HIGH',
      state: 'OPEN',
      title: 'a finding recorded after the freeze',
      layer: 1,
      evidence: ['tools/gates/finding-registry.ts:1'],
      owner_agent: 'claude',
      raised_in_cycle: '2026-10-25-mf-2-fixture',
      review_file: FIXTURE_REVIEW_FILE,
      created_at: '2026-10-20T00:00:00Z',
      deadline: '2099-12-31',
      owner_user: 'Okan-wqm',
      notes: '',
      ...overrides,
    });
  let frozen = '';
  let genesisRun: CliRun | undefined;
  let genesisText = '';
  let genesisRerunText = '';

  beforeAll(() => {
    repo.write('.gitignore', 'node_modules\nstubs/\n');
    repo.writeRegistry([
      // Past its deadline with an owner: the sweep blocks it.
      fixtureFinding('ARIA-HIGH-901', { deadline: '2026-01-31' }),
      // Registered without an owner or a deadline: `assign` fills them.
      fixtureFinding('ARIA-HIGH-902', { owner_user: null, deadline: null }),
      // Control: nothing touches it.
      fixtureFinding('ARIA-MEDIUM-903', { deadline: '2099-12-31' }),
    ]);
    repo.commit('chore(registry): seed the legacy registry', '2026-10-01T10:00:00Z');
    frozen = repo.read(REGISTRY_RELATIVE_PATH);
    genesisRun = repo.registry(['genesis']);
    if (genesisRun.status === 0) {
      genesisText = repo.read(GENESIS_RELATIVE_PATH);
      repo.registry(['genesis']);
      genesisRerunText = repo.read(GENESIS_RELATIVE_PATH);
      repo.commit(
        'chore(registry): freeze findings.jsonl as the genesis segment',
        '2026-10-02T10:00:00Z',
      );
    }
  }, CLI_TEST_TIMEOUT_MS);

  afterAll(() => repo.dispose());

  it('`genesis` pins the frozen blob, reproducibly, and the landing step can rerun it by name', () => {
    expect(genesisRun?.status).toBe(0);
    expect(JSON.parse(genesisText)).toMatchObject({
      path: REGISTRY_RELATIVE_PATH,
      blob_sha256: sha256(Buffer.from(frozen, 'utf8')),
      entries: 3,
      tip_content_hash: lastRowHash(frozen),
    });
    expect(genesisRerunText).toBe(genesisText);
    const scripts = (
      JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['findings:genesis']).toMatch(/tools\/gates\/finding-registry\.ts genesis\b/);
  });

  it(
    '`add` creates the finding’s own file with one CREATED event and leaves findings.jsonl untouched',
    () => {
      repo.write('stubs/open.json', stub());
      expectOk(repo.registry(['add', 'ARIA', 'stubs/open.json']));
      expect(repo.read(REGISTRY_RELATIVE_PATH)).toBe(frozen);
      const file = eventFilePath('ARIA-HIGH-904');
      expect(eventFiles(repo.root)).toEqual([file]);
      const [created, ...rest] = readEvents(repo.root, file);
      expect(rest).toEqual([]);
      expect(Object.keys(created ?? {}).sort()).toEqual([...EVENT_FIELDS].sort());
      expect(created).toMatchObject({
        finding_id: 'ARIA-HIGH-904',
        version: 1,
        event_type: 'CREATED',
        reason: null,
        prev_hash: lastRowHash(frozen),
      });
      expect(created?.event_id).toMatch(UUID_SHAPE);
      expect(created?.payload).toMatchObject({
        id: 'ARIA-HIGH-904',
        state: 'OPEN',
        title: 'a finding recorded after the freeze',
        closing_commits: [],
        closed_at: null,
      });
      expect(created?.payload).not.toHaveProperty('prev_hash');
      expect(created?.payload).not.toHaveProperty('content_hash');
      expect(created?.content_hash).toBe(eventContentHash(withoutContentHash(created)));
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    '`add` refuses a stub registered RESOLVED and writes nothing',
    () => {
      const before = eventFiles(repo.root);
      repo.write(
        'stubs/resolved.json',
        stub({
          state: 'RESOLVED',
          closing_commits: ['a'.repeat(40)],
          closed_at: '2026-10-20T00:00:00Z',
        }),
      );
      const run = repo.registry(['add', 'ARIA', 'stubs/resolved.json']);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('RESOLVED');
      expect(eventFiles(repo.root)).toEqual(before);
      expect(repo.read(REGISTRY_RELATIVE_PATH)).toBe(frozen);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    '`assign` appends OWNER_ASSIGNED anchored on the genesis row',
    () => {
      expectOk(
        repo.registry([
          'assign',
          'ARIA-HIGH-902',
          '--owner-user=Okan-wqm',
          '--deadline=2099-12-31',
          '--reason=the operator owns registry follow-ups',
        ]),
      );
      expect(repo.read(REGISTRY_RELATIVE_PATH)).toBe(frozen);
      const events = readEvents(repo.root, eventFilePath('ARIA-HIGH-902'));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        finding_id: 'ARIA-HIGH-902',
        version: 1,
        event_type: 'OWNER_ASSIGNED',
        payload: { owner_user: 'Okan-wqm', deadline: '2099-12-31' },
        prev_hash: rowHash(frozen, 'ARIA-HIGH-902'),
      });
      expect(String(events[0]?.reason).trim()).not.toBe('');
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    '`sweep` appends STATE_TRANSITIONED to the findings it moves and to no other',
    () => {
      expectOk(repo.registry(['sweep', '--stale-after=36500']));
      expect(repo.read(REGISTRY_RELATIVE_PATH)).toBe(frozen);
      const events = readEvents(repo.root, eventFilePath('ARIA-HIGH-901'));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        finding_id: 'ARIA-HIGH-901',
        version: 1,
        event_type: 'STATE_TRANSITIONED',
        payload: { from_state: 'OPEN', to_state: 'BLOCKED' },
        prev_hash: rowHash(frozen, 'ARIA-HIGH-901'),
      });
      expect(existsSync(join(repo.root, eventFilePath('ARIA-MEDIUM-903')))).toBe(false);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    '`project` reads genesis and the event logs, and `verify` holds',
    () => {
      const run = repo.project();
      expectOk(run);
      const rows = new Map(run.rows.map((row) => [row.id, row]));
      expect([...rows.keys()].sort()).toEqual([
        'ARIA-HIGH-901',
        'ARIA-HIGH-902',
        'ARIA-HIGH-904',
        'ARIA-MEDIUM-903',
      ]);
      expect(rows.get('ARIA-HIGH-901')?.state).toBe('BLOCKED');
      expect(rows.get('ARIA-HIGH-902')).toMatchObject({
        owner_user: 'Okan-wqm',
        deadline: '2099-12-31',
      });
      expect(rows.get('ARIA-HIGH-904')?.state).toBe('OPEN');
      expect(rows.get('ARIA-MEDIUM-903')?.state).toBe('OPEN');
      expectOk(repo.registry(['verify']));
    },
    CLI_TEST_TIMEOUT_MS,
  );

  describe('T7 — `verify --base` holds every event file to append-only against the base', () => {
    let main = '';

    beforeAll(() => {
      main = repo.commit('chore(findings): writes after the freeze', '2026-10-03T10:00:00Z');
    });

    it(
      'refuses a rewritten event line',
      () => {
        repo.git(['checkout', '-q', '-b', 'rewrite', main]);
        const file = eventFilePath('ARIA-HIGH-902');
        expect(existsSync(join(repo.root, file))).toBe(true);
        const [first] = readEvents(repo.root, file);
        // The line stays internally consistent: only the history check can see it.
        const rewritten = {
          ...withoutContentHash(first),
          reason: 'a different reason, written over the first',
        };
        repo.write(
          file,
          serializeEvents([{ ...rewritten, content_hash: eventContentHash(rewritten) }]),
        );
        repo.commit('chore(findings): rewrite a past event', '2026-10-04T10:00:00Z');
        const run = repo.registry(['verify', `--base=${main}`]);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain(file);
        repo.git(['checkout', '-q', 'main']);
      },
      CLI_TEST_TIMEOUT_MS,
    );

    it(
      'refuses a deleted event file',
      () => {
        repo.git(['checkout', '-q', '-b', 'delete', main]);
        const file = eventFilePath('ARIA-HIGH-901');
        expect(existsSync(join(repo.root, file))).toBe(true);
        rmSync(join(repo.root, file));
        repo.commit('chore(findings): delete a finding’s history', '2026-10-04T11:00:00Z');
        const run = repo.registry(['verify', `--base=${main}`]);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain(file);
        repo.git(['checkout', '-q', 'main']);
      },
      CLI_TEST_TIMEOUT_MS,
    );

    it(
      'passes a pure append',
      () => {
        repo.git(['checkout', '-q', '-b', 'append', main]);
        const file = eventFilePath('ARIA-HIGH-901');
        expect(existsSync(join(repo.root, file))).toBe(true);
        const prior = readEvents(repo.root, file);
        const appended = nextEvent('ARIA-HIGH-901', prior, rowHash(frozen, 'ARIA-HIGH-901'), {
          event_type: 'STATE_TRANSITIONED',
          payload: transition('BLOCKED', 'OPEN'),
          reason: 'the deadline moved with the plan',
          occurred_at: '2026-10-04T12:00:00Z',
        });
        repo.write(file, serializeEvents([...prior, appended]));
        repo.commit('chore(findings): reopen after the plan moved', '2026-10-04T12:00:00Z');
        expectOk(repo.registry(['verify', `--base=${main}`]));
        repo.git(['checkout', '-q', 'main']);
      },
      CLI_TEST_TIMEOUT_MS,
    );
  });
});

/**
 * `event` with `overrides`, re-hashed: a line that is consistent in every
 * respect except the ones the test changed, so exactly one check can see it.
 */
function restamp(
  event: FindingEventLine,
  overrides: Partial<Omit<FindingEventLine, 'content_hash'>>,
): FindingEventLine {
  const body = { ...withoutContentHash(event), ...overrides };
  return { ...body, content_hash: eventContentHash(body) };
}

/** A line the typed helpers cannot express (a key added or missing): `body` plus its own hash. */
function sealed(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, content_hash: sha256hex(canonicalJson(body)) };
}

/** The bytes of a log: one JSON object per line, newline-terminated. */
function logText(lines: readonly object[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join('');
}

/** Every byte the registry holds: the genesis segment and every event log. */
function storeBytes(repo: RegistryFixtureRepo): string {
  return [REGISTRY_RELATIVE_PATH, ...eventFiles(repo.root)]
    .map((rel) => `${rel}\n${repo.read(rel)}`)
    .join('\n');
}

/** What a refused run must look like: status 1, every named defect on stderr, nothing else to show. */
const REFUSED_AND_NAMED = { status: 1, unnamed: [], stderr: '' };

/** The run's status and the defects it did not name; its stderr only when it is not the refusal asked for. */
function refusalOf(
  run: CliRun,
  names: readonly string[],
): { status: number | null; unnamed: string[]; stderr: string } {
  const unnamed = names.filter((name) => !run.stderr.includes(name));
  return {
    status: run.status,
    unnamed,
    stderr: run.status === 1 && unnamed.length === 0 ? '' : run.stderr,
  };
}

/**
 * MF-2 — the removed finding-event.spec.ts pinned that a corrupt log is
 * refused (a version gap, a tampered line, a broken chain, a non-exact
 * payload, a transition from a terminal state). The verifier and the fold that
 * replaced it enforce each of those, but nothing fed them a corrupt store, so
 * deleting any one check left every suite green. Each case below writes ONE
 * defect over a store that verifies, in a line that is consistent in every
 * other respect, and requires the check that names it to say so. The control
 * first: the untouched store is accepted, so a refusal below is the defect's.
 *
 * Killed (each name is the one-line mutation of production the case fails
 * under): M01 version, M02 content_hash, M03 prev_hash, M04 and M13 the event
 * schema (stored lines; the exact STATE_TRANSITIONED payload), M05-M08 the
 * fold's refusals, M09 duplicate event ids, M10 CREATED placement, M11 the
 * top-level field set, M12 the sink's event-schema check.
 */
describe('MF-2 - the verifier, the fold and the sink name every defect of a corrupt store', () => {
  const repo = RegistryFixtureRepo.create('mf2-corrupt-store-');
  const OPEN_OWNED = 'ARIA-HIGH-901';
  const OWNERLESS = 'ARIA-HIGH-902';
  const OWNED_MEDIUM = 'ARIA-MEDIUM-903';
  const BORN = 'ARIA-HIGH-904';
  const CLOSED = 'ARIA-HIGH-905';
  const STRAY = 'ARIA-HIGH-906';
  const GENESIS_IDS: readonly string[] = [OPEN_OWNED, OWNERLESS, OWNED_MEDIUM, CLOSED];
  const ownerlessFile = eventFilePath(OWNERLESS);
  const bornFile = eventFilePath(BORN);
  const ownedMediumFile = eventFilePath(OWNED_MEDIUM);
  const openOwnedFile = eventFilePath(OPEN_OWNED);
  const closedFile = eventFilePath(CLOSED);
  const strayFile = eventFilePath(STRAY);
  let genesisText = '';

  /** Where line 1 of `id`'s log chains: its genesis row, else the genesis tip. */
  const anchorOf = (id: string): string =>
    GENESIS_IDS.includes(id) ? rowHash(genesisText, id) : lastRowHash(genesisText);

  /** The next line of `id`'s log after `prior`. */
  const append = (
    id: string,
    prior: readonly FindingEventLine[],
    event_type: FindingEventLine['event_type'],
    payload: Record<string, unknown>,
  ): FindingEventLine =>
    nextEvent(id, prior, anchorOf(id), {
      event_type,
      payload,
      reason: event_type === 'CREATED' ? null : `a reason for ${event_type}`,
      occurred_at: AT,
    });

  /** The ownerless finding's first line: the assignment that fills its owner and deadline. */
  const assigned = (): FindingEventLine =>
    append(OWNERLESS, [], 'OWNER_ASSIGNED', { owner_user: 'Okan-wqm', deadline: '2099-12-31' });
  /** Its second line: past its deadline, it is blocked. */
  const blocked = (prior: readonly FindingEventLine[]): FindingEventLine =>
    append(OWNERLESS, prior, 'STATE_TRANSITIONED', transition('OPEN', 'BLOCKED'));
  /** The finding born after the freeze: its one CREATED line. */
  const created = (id = BORN): FindingEventLine =>
    append(id, [], 'CREATED', createdPayload(fixtureFinding(id)));

  /** The store the control accepts: two logs, one anchored on a genesis row, one on the tip. */
  const intactLogs = (): Record<string, string> => {
    const first = assigned();
    return {
      [ownerlessFile]: logText([first, blocked([first])]),
      [bornFile]: logText([created()]),
    };
  };

  /** Put the committed store back: a case leaves nothing behind for the next. */
  const restore = (): void => {
    repo.git(['reset', '-q', '--hard']);
    repo.git(['clean', '-fdq']);
  };

  /** `verify` over the store with `files` written over it: refused, naming every defect in `names`. */
  const verifyRefuses = (
    files: Readonly<Record<string, string>>,
    names: readonly string[],
  ): void => {
    try {
      for (const [rel, text] of Object.entries(files)) repo.write(rel, text);
      expect(refusalOf(repo.registry(['verify']), names)).toEqual(REFUSED_AND_NAMED);
    } finally {
      restore();
    }
  };

  /** Both readers of the fold, `verify` and `project`, refuse the store with `files` written over it, naming `text`. */
  const foldRefuses = (files: Readonly<Record<string, string>>, text: string): void => {
    try {
      for (const [rel, body] of Object.entries(files)) repo.write(rel, body);
      expect({
        verify: refusalOf(repo.registry(['verify']), [text]),
        project: refusalOf(repo.project(), [text]),
      }).toEqual({ verify: REFUSED_AND_NAMED, project: REFUSED_AND_NAMED });
    } finally {
      restore();
    }
  };

  beforeAll(() => {
    repo.writeRegistry([
      fixtureFinding(OPEN_OWNED, { deadline: '2099-12-31' }),
      // Registered without an owner or a deadline: an assignment fills them.
      fixtureFinding(OWNERLESS, { owner_user: null, deadline: null }),
      fixtureFinding(OWNED_MEDIUM, { deadline: '2099-12-31' }),
      // Recorded RESOLVED, closed by a commit: it leaves RESOLVED only by CLOSURE_REJECTED.
      fixtureFinding(CLOSED, {
        state: 'RESOLVED',
        closing_commits: ['a'.repeat(40)],
        closed_at: '2026-10-02T00:00:00Z',
        deadline: '2099-12-31',
      }),
    ]);
    repo.commit('chore(registry): seed the legacy registry', '2026-10-01T10:00:00Z');
    expectOk(repo.registry(['genesis']));
    genesisText = repo.read(REGISTRY_RELATIVE_PATH);
    for (const [rel, text] of Object.entries(intactLogs())) repo.write(rel, text);
    repo.commit('chore(findings): the freeze, and two logs after it', '2026-10-02T10:00:00Z');
  }, CLI_TEST_TIMEOUT_MS);

  afterAll(() => repo.dispose());

  it(
    'control: the intact store verifies and projects, so every refusal below is its one defect',
    () => {
      expectOk(repo.registry(['verify']));
      const run = repo.project();
      expectOk(run);
      const rows = new Map(run.rows.map((row) => [row.id, row]));
      expect(rows.get(OWNERLESS)).toMatchObject({
        state: 'BLOCKED',
        owner_user: 'Okan-wqm',
        deadline: '2099-12-31',
      });
      expect(rows.get(BORN)?.state).toBe('OPEN');
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'names a version gap [M01]',
    () => {
      const first = assigned();
      verifyRefuses({ [ownerlessFile]: logText([restamp(first, { version: 3 })]) }, [
        `${ownerlessFile}:1: version 3`,
      ]);
      const second = blocked([first]);
      verifyRefuses({ [ownerlessFile]: logText([first, restamp(second, { version: 4 })]) }, [
        `${ownerlessFile}:2: version 4`,
      ]);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'names a line whose content_hash is not the hash of the line [M02]',
    () => {
      // A decision edited in place, the hash left as it was.
      const first = assigned();
      const edited = { ...first, payload: { ...first.payload, deadline: '2030-01-01' } };
      verifyRefuses({ [ownerlessFile]: logText([edited]) }, [
        `${ownerlessFile}:1: content_hash does not match the line`,
      ]);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'names a line that does not chain: a wrong anchor, the tip for a genesis row, a wrong predecessor [M03]',
    () => {
      const first = assigned();
      // Line 1 anchored on nothing the store holds; line 2 chained on it, so only line 1 is wrong.
      const orphan = restamp(first, { prev_hash: 'e'.repeat(64) });
      const afterOrphan = blocked([orphan]);
      verifyRefuses({ [ownerlessFile]: logText([orphan, afterOrphan]) }, [
        `${ownerlessFile}:1: prev_hash does not chain`,
      ]);
      // A genesis finding anchors on its own row, not on the genesis tip.
      const onTip = restamp(first, { prev_hash: lastRowHash(genesisText) });
      verifyRefuses({ [ownerlessFile]: logText([onTip]) }, [
        `${ownerlessFile}:1: prev_hash does not chain`,
      ]);
      // Line 2 chained on something other than line 1.
      verifyRefuses(
        {
          [ownerlessFile]: logText([
            first,
            restamp(blocked([first]), { prev_hash: 'e'.repeat(64) }),
          ]),
        },
        [`${ownerlessFile}:2: prev_hash does not chain`],
      );
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'names a payload outside the exact event contract [M04, M13]',
    () => {
      const first = assigned();
      // The fold ignores a key it does not know: only the event schema sees it.
      const smuggled = append(OWNERLESS, [first], 'STATE_TRANSITIONED', {
        ...transition('OPEN', 'BLOCKED'),
        smuggled: true,
      });
      verifyRefuses({ [ownerlessFile]: logText([first, smuggled]) }, [
        `${ownerlessFile}:2: /payload: must NOT have additional properties`,
      ]);
      // RESOLVED is not a state a line may write; the fold would take it, the schema must not.
      const resolved = append(OWNERLESS, [first], 'STATE_TRANSITIONED', {
        from_state: 'OPEN',
        to_state: 'RESOLVED',
      });
      verifyRefuses({ [ownerlessFile]: logText([first, resolved]) }, [
        `${ownerlessFile}:2: /payload/to_state`,
      ]);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'names a top-level key added to a line or missing from it, in the verifier’s own words [M11]',
    () => {
      const first = assigned();
      const body = withoutContentHash(first);
      const keys = (names: readonly string[]): string => [...names].sort().join(',');
      verifyRefuses({ [ownerlessFile]: logText([sealed({ ...body, main_sha: 'a'.repeat(40) })]) }, [
        `${ownerlessFile}:1: fields ${keys([...EVENT_FIELDS, 'main_sha'])}`,
      ]);
      const { actor: _actor, ...withoutActor } = body;
      verifyRefuses({ [ownerlessFile]: logText([sealed(withoutActor)]) }, [
        `${ownerlessFile}:1: fields ${keys(EVENT_FIELDS.filter((field) => field !== 'actor'))}`,
      ]);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'names CREATED where it may not stand, and CREATED missing where it must [M10]',
    () => {
      // A genesis finding already exists: its log may not create it again.
      verifyRefuses({ [ownedMediumFile]: logText([created(OWNED_MEDIUM)]) }, [
        `${ownedMediumFile}:1: CREATED where it may not stand (a genesis finding)`,
      ]);
      // A finding born after the freeze starts with CREATED, and only there.
      const stray = append(STRAY, [], 'OWNER_ASSIGNED', { owner_user: 'Okan-wqm' });
      verifyRefuses({ [strayFile]: logText([stray]) }, [
        `${strayFile}:1: CREATED missing (not in genesis)`,
      ]);
      const first = created();
      const again = append(BORN, [first], 'CREATED', createdPayload(fixtureFinding(BORN)));
      verifyRefuses({ [bornFile]: logText([first, again]) }, [
        `${bornFile}:2: CREATED where it may not stand (not in genesis)`,
      ]);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'names one event id written to two logs [M09]',
    () => {
      // Valid on its own: a UUID, chained, hashed, folding cleanly. Only the pair is the defect.
      const first = assigned();
      const twin = restamp(append(OWNED_MEDIUM, [], 'OWNER_ASSIGNED', { owner_user: 'Okan-wqm' }), {
        event_id: first.event_id,
      });
      verifyRefuses(
        {
          [ownerlessFile]: logText([first]),
          [ownedMediumFile]: logText([twin]),
        },
        [
          `event_id ${first.event_id} in ${relative(EVENT_STORE_RELATIVE_DIR, ownerlessFile)} ` +
            `and ${relative(EVENT_STORE_RELATIVE_DIR, ownedMediumFile)}`,
        ],
      );
    },
    CLI_TEST_TIMEOUT_MS,
  );

  describe('the fold refuses what its row cannot take, for `verify` and `project` alike', () => {
    it(
      'a transition from a state the row is not in [M05]',
      () => {
        foldRefuses(
          {
            [openOwnedFile]: logText([
              append(OPEN_OWNED, [], 'STATE_TRANSITIONED', transition('BLOCKED', 'STALE')),
            ]),
          },
          `registry fold: ${OPEN_OWNED} v1 STATE_TRANSITIONED: from_state BLOCKED, but the row is OPEN`,
        );
      },
      CLI_TEST_TIMEOUT_MS,
    );

    it(
      'a transition to the state the row is already in [M06]',
      () => {
        foldRefuses(
          {
            [openOwnedFile]: logText([
              append(OPEN_OWNED, [], 'STATE_TRANSITIONED', transition('OPEN', 'OPEN')),
            ]),
          },
          `registry fold: ${OPEN_OWNED} v1 STATE_TRANSITIONED: to_state OPEN is the row's state`,
        );
      },
      CLI_TEST_TIMEOUT_MS,
    );

    it(
      'a transition of a finding a commit closed: it leaves RESOLVED only by CLOSURE_REJECTED [M07]',
      () => {
        foldRefuses(
          {
            [closedFile]: logText([
              append(CLOSED, [], 'STATE_TRANSITIONED', transition('RESOLVED', 'OPEN')),
            ]),
          },
          `registry fold: ${CLOSED} v1 STATE_TRANSITIONED: a finding a commit closed leaves RESOLVED only by CLOSURE_REJECTED`,
        );
      },
      CLI_TEST_TIMEOUT_MS,
    );

    it(
      'an assignment that would change an owner or a deadline instead of filling it [M08]',
      () => {
        foldRefuses(
          {
            [ownedMediumFile]: logText([
              append(OWNED_MEDIUM, [], 'OWNER_ASSIGNED', { owner_user: 'Another-Handle' }),
            ]),
          },
          `registry fold: ${OWNED_MEDIUM} v1 OWNER_ASSIGNED: owner_user is already Okan-wqm; an assignment fills, never changes`,
        );
        foldRefuses(
          {
            [ownedMediumFile]: logText([
              append(OWNED_MEDIUM, [], 'OWNER_ASSIGNED', { deadline: '2099-01-01' }),
            ]),
          },
          `registry fold: ${OWNED_MEDIUM} v1 OWNER_ASSIGNED: deadline is already 2099-12-31; an assignment fills, never changes`,
        );
      },
      CLI_TEST_TIMEOUT_MS,
    );
  });

  it(
    'the sink refuses a line that breaks the event contract and writes nothing [M12]',
    () => {
      const layout = registryLayout(join(repo.root, 'docs', 'reviews', '_registry'));
      const transitionDraft = (
        payload: { readonly from_state: FindingState; readonly to_state: GitStateTarget },
        reason: string,
      ): FindingEventDraft => ({
        finding_id: OPEN_OWNED,
        event_type: 'STATE_TRANSITIONED',
        payload,
        actor: 'Okan-wqm',
        reason,
        occurred_at: AT,
      });
      const sink = (draft: FindingEventDraft): string[] =>
        withRegistryFileLock(layout.dir, (lease) => appendFindingEvents(layout, [draft], lease));
      const violationsOf = (draft: FindingEventDraft): string => {
        try {
          sink(draft);
        } catch (error) {
          if (error instanceof RegistryWriteRefused) return error.violations.join('\n');
          throw error;
        }
        return '';
      };
      const before = storeBytes(repo);
      try {
        // Each is accepted by the fold and the row contract: only the event schema refuses it.
        const smuggled = {
          from_state: 'OPEN' as const,
          to_state: 'BLOCKED' as const,
          smuggled: true,
        };
        expect(violationsOf(transitionDraft(smuggled, 'past its deadline'))).toContain(
          `${OPEN_OWNED} event 1: /payload: must NOT have additional properties`,
        );
        const blank = transitionDraft({ from_state: 'OPEN', to_state: 'BLOCKED' }, '   ');
        expect(violationsOf(blank)).toContain(`${OPEN_OWNED} event 1: /reason`);
        expect(storeBytes(repo)).toBe(before);

        // Control: the same transition with a reason is appended, to the finding's own file.
        const accepted = transitionDraft(
          { from_state: 'OPEN', to_state: 'BLOCKED' },
          'past its deadline',
        );
        expect(sink(accepted)).toEqual([relative(EVENT_STORE_RELATIVE_DIR, openOwnedFile)]);
        expect(readEvents(repo.root, openOwnedFile)).toHaveLength(1);
      } finally {
        restore();
      }
    },
    CLI_TEST_TIMEOUT_MS,
  );
});

/**
 * MF-2 T7 — `verify --base` also holds the freeze itself. The removed
 * `checkCanonicalRegistryPrefix` refused a branch that rewrote canonical
 * history; its successor is `appendOnlyDefects`' rule that genesis.json is
 * unchanged since the base. A branch that rewrites a frozen row, rechains the
 * rows after it and re-pins is self-consistent: the chain verifies, the pin
 * matches, and with no event log anchored on the old rows no other check has
 * anything to say. This fixture's base holds only the freeze, so that rule is
 * the only one that can refuse it [M15].
 */
describe('MF-2 T7 - `verify --base` refuses a genesis segment rewritten and re-pinned: the freeze is final', () => {
  const repo = RegistryFixtureRepo.create('mf2-freeze-final-');
  const first = fixtureFinding('ARIA-HIGH-901');
  const second = fixtureFinding('ARIA-HIGH-902');
  const third = fixtureFinding('ARIA-MEDIUM-903');
  const PIN = 'docs/reviews/_registry/genesis.json';
  let main = '';

  beforeAll(() => {
    repo.writeRegistry([first, second, third]);
    repo.commit('chore(registry): seed the legacy registry', '2026-10-01T10:00:00Z');
    expectOk(repo.registry(['genesis']));
    main = repo.commit(
      'chore(registry): freeze findings.jsonl as the genesis segment',
      '2026-10-02T10:00:00Z',
    );
  }, CLI_TEST_TIMEOUT_MS);

  afterAll(() => repo.dispose());

  it(
    'passes a branch that leaves the freeze alone',
    () => {
      expectOk(repo.registry(['verify', `--base=${main}`]));
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a branch that rewrites a frozen row, rechains and re-pins',
    () => {
      repo.git(['checkout', '-q', '-b', 'rewrite', main]);
      repo.writeRegistry([first, { ...second, title: 'a frozen row, rewritten' }, third]);
      expectOk(repo.registry(['genesis']));
      repo.commit('chore(registry): rewrite a frozen row and re-pin', '2026-10-03T10:00:00Z');
      // Self-consistent: the chain, the pin and the (empty) store all verify.
      expectOk(repo.registry(['verify']));
      expect(repo.read(PIN)).not.toBe(repo.git(['show', `${main}:${PIN}`]));
      const run = repo.registry(['verify', `--base=${main}`]);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`${PIN}: changed since ${main} (the freeze is final)`);
      repo.git(['checkout', '-q', 'main']);
    },
    CLI_TEST_TIMEOUT_MS,
  );
});

/**
 * MF-2 — the landing step. The removed driver specs pinned that a merge of
 * upstream rows into a branch with rows of its own keeps a valid chain. The
 * per-finding store has one such interplay left, and it is the MF-2 landing
 * itself: the branch carries the freeze (genesis.json) and the logs of the
 * findings it recorded, anchored on the genesis tip; origin/main, still
 * written by the old writers, appends legacy rows to findings.jsonl. After
 * the merge the pin is stale and the tip has moved, so the born logs anchor on
 * a tip that is gone; `finding-registry genesis` (`npm run findings:genesis`)
 * re-pins and re-anchors them, keeping every decision [M31].
 */
describe('MF-2 - the landing step re-anchors the logs of findings born on the branch', () => {
  const repo = RegistryFixtureRepo.create('mf2-landing-reanchor-');
  const BORN = 'ARIA-HIGH-904';
  const bornFile = eventFilePath(BORN);
  const legacy = [
    fixtureFinding('ARIA-HIGH-901'),
    fixtureFinding('ARIA-HIGH-902'),
    fixtureFinding('ARIA-MEDIUM-903'),
  ];

  afterAll(() => repo.dispose());

  /** The decisions a line records: everything but the position hashes and the id that follows them. */
  const decisions = (lines: readonly FindingEventLine[]): unknown[] =>
    lines.map((line) => ({
      finding_id: line.finding_id,
      version: line.version,
      event_type: line.event_type,
      payload: line.payload,
      actor: line.actor,
      reason: line.reason,
      occurred_at: line.occurred_at,
    }));

  it(
    'a merge of main that brings a legacy row breaks the born log; `genesis` re-anchors it and no decision changes',
    () => {
      repo.writeRegistry(legacy);
      repo.commit('chore(registry): seed the legacy registry', '2026-10-01T10:00:00Z');

      // The branch freezes the registry and records a finding: CREATED, then one
      // decision, anchored on the tip it saw.
      repo.git(['checkout', '-q', '-b', 'feature']);
      expectOk(repo.registry(['genesis']));
      const frozenTip = lastRowHash(repo.read(REGISTRY_RELATIVE_PATH));
      const born = nextEvent(BORN, [], frozenTip, {
        event_type: 'CREATED',
        payload: createdPayload(fixtureFinding(BORN)),
        reason: null,
        occurred_at: AT,
      });
      const staled = nextEvent(BORN, [born], frozenTip, {
        event_type: 'STATE_TRANSITIONED',
        payload: transition('OPEN', 'STALE'),
        reason: 'the plan it belonged to moved',
        occurred_at: AT,
      });
      repo.write(bornFile, serializeEvents([born, staled]));
      repo.commit(
        'chore(registry): freeze the segment and record a finding',
        '2026-10-02T10:00:00Z',
      );
      expectOk(repo.registry(['verify']));

      // main, before the freeze, takes a legacy row from the old writer: the tip moves.
      repo.git(['checkout', '-q', 'main']);
      repo.writeRegistry([...legacy, fixtureFinding('ARIA-HIGH-907')]);
      repo.commit('chore(registry): a legacy row lands on main', '2026-10-03T10:00:00Z');

      repo.git(['checkout', '-q', 'feature']);
      repo.merge('main', '2026-10-04T10:00:00Z');
      const movedTip = lastRowHash(repo.read(REGISTRY_RELATIVE_PATH));
      expect(movedTip).not.toBe(frozenTip);

      // The merge is clean, and the born log now anchors on a tip that is gone.
      const broken = repo.registry(['verify']);
      expect(broken.status).toBe(1);
      expect(broken.stderr).toContain(`${bornFile}:1: prev_hash does not chain`);

      // The landing step re-pins and re-anchors it...
      const landing = repo.registry(['genesis']);
      expectOk(landing);
      expect(landing.stdout).toContain(
        `re-anchored ${relative(EVENT_STORE_RELATIVE_DIR, bornFile)} on the new tip`,
      );
      expectOk(repo.registry(['verify']));

      // ...onto the new tip, down the whole log, with every decision as it was written.
      const after = readEvents(repo.root, bornFile);
      expect(after).toHaveLength(2);
      expect(after[0]?.prev_hash).toBe(movedTip);
      expect(after[1]?.prev_hash).toBe(after[0]?.content_hash);
      expect(decisions(after)).toEqual(decisions([born, staled]));
      expect(after.map((line) => line.content_hash)).not.toEqual([
        born.content_hash,
        staled.content_hash,
      ]);

      // A rerun has nothing left to re-anchor: the pin and the segment agree.
      const rerun = repo.registry(['genesis']);
      expectOk(rerun);
      expect(rerun.stdout).not.toContain('re-anchored');
      expect(readEvents(repo.root, bornFile)).toEqual(after);
    },
    CLI_TEST_TIMEOUT_MS,
  );
});

describe('MF-2 §9 Q2 — one event vocabulary: the Postgres ledger mirrors the git event', () => {
  const LEDGER = 'tools/gates/finding-event-ledger.ts';

  it('the ledger takes its event from the git store and reads the registry through the projection', () => {
    const source = readFileSync(join(REPO_ROOT, LEDGER), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports).toEqual(
      expect.arrayContaining(['./finding-registry-events', './finding-registry-projection']),
    );
    expect(imports).not.toContain('../../libs/backend-common/src/finding-registry/finding-event');
    expect(source).not.toContain('docs/reviews/_registry/findings.jsonl');
  });

  it('the ledger’s own vocabulary is gone from live code (migrations are history)', () => {
    const listed = spawnSync(
      'git',
      [
        '-C',
        REPO_ROOT,
        'grep',
        '-l',
        '-e',
        'EVIDENCE_ADDED',
        '--',
        'tools',
        'libs',
        'apps',
        'aria-kernel',
        'scripts',
        ':(exclude,glob)apps/*/src/migrations/**',
        ':(exclude,glob)apps/*/src/database/migrations/**',
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    // git grep: exit 1 means no match, 0 lists the files; anything else is a failed scan.
    expect([0, 1]).toContain(listed.status);
    expect(listed.stdout.split('\n').filter(Boolean)).toEqual([]);
  });
});

describe('MF-3 is tracked: the branch converter has a retirement finding', () => {
  it('the event store records an OPEN finding to retire finding-registry-migrate-branch.ts, owned and dated', () => {
    const created = eventFiles(REPO_ROOT)
      .flatMap((rel) => readEvents(REPO_ROOT, rel))
      .filter(
        (event) =>
          event.event_type === 'CREATED' &&
          String(event.payload.title ?? '').includes('finding-registry-migrate-branch'),
      );
    expect(created.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        state: 'OPEN',
        owner_user: 'Okan-wqm',
        deadline: '2026-11-25',
      }),
    ]);
  });
});
