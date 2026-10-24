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
 *     one, and passes a pure append.
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

import { type Finding, type FindingState } from '../../tools/gates/finding-registry-chain';
import type { GitStateTarget } from '../../tools/gates/finding-registry-events';

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
