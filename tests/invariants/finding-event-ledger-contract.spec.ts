/**
 * The Postgres finding event ledger is a pure mirror of the git registry
 * (MF-2, MF-DESIGN §9 Q2; DATA-HIGH-011).
 *
 * The registry's authority is git: a frozen genesis segment and one
 * append-only event log per finding (tools/gates/finding-registry-events.ts).
 * The ledger table keeps every git event line verbatim and no vocabulary of
 * its own; its one writer, tools/gates/finding-event-ledger.ts, mirrors the
 * lines of a commit on origin/main and checks parity against the projection.
 * What this pins:
 *
 *   - the table stays the immutable envelope it was created as, and the
 *     mirror migration replaces its own event-type list with a check that
 *     every envelope column is the field of the line it carries;
 *   - the entity maps that envelope with the same checks;
 *   - parity: a ledger holding exactly the git lines passes, and a missing,
 *     extra or altered row is named; the digest follows the chain heads;
 *   - the mirror's INSERT: executed against a recording stand-in for the
 *     connection (no Postgres runs in this lane), the payload it binds is the
 *     git line verbatim and every other column is that line's field.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  INSERT_FINDING_EVENT_SQL,
  type LedgerRow,
  type LedgerSession,
  mirrorDifferences,
  mirrorInto,
  registryDigest,
  storeEvents,
} from '../../tools/gates/finding-event-ledger';
import { type Finding, rechain } from '../../tools/gates/finding-registry-chain';
import {
  chainEvent,
  type FindingEventLine,
  serializeEventLines,
} from '../../tools/gates/finding-registry-events';
import {
  eventLogRelativePath,
  type RegistryStore,
} from '../../tools/gates/finding-registry-projection';

const ROOT = resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');
const ledgerTable = read(
  'apps/event-store-service/src/migrations/1801200000000-CreateFindingEventsLedger.ts',
);
const mirrorMigration = read(
  'apps/event-store-service/src/migrations/1801300000000-MirrorGitFindingEvents.ts',
);
const entity = read('apps/event-store-service/src/finding-registry/finding-event.entity.ts');
const registryCli = read('tools/gates/finding-registry.ts');

function legacyRow(id: string): Finding {
  return {
    id,
    severity: 'HIGH',
    state: 'OPEN',
    title: `ledger fixture finding ${id}`,
    evidence: ['tools/gates/finding-event-ledger.ts:1'],
    owner_agent: 'claude',
    raised_in_cycle: '2026-10-25-mf-2-ledger',
    created_at: '2026-10-01T00:00:00Z',
    closed_at: null,
    closing_commits: [],
    deadline: '2099-12-31',
    owner_user: 'Okan-wqm',
    override_of: null,
    prev_hash: '',
    content_hash: '',
  };
}

/** A registry with two genesis rows and events on one of them and on a new finding. */
function fixtureStore(): RegistryStore {
  const genesis = [legacyRow('ARIA-HIGH-901'), legacyRow('ARIA-HIGH-902')];
  rechain(genesis, 0);
  const tip = genesis[1]?.content_hash ?? '';
  const anchor901 = genesis[0]?.content_hash ?? '';
  const at = '2026-10-25T00:00:00Z';
  const stale = chainEvent(
    {
      finding_id: 'ARIA-HIGH-901',
      event_type: 'STATE_TRANSITIONED',
      payload: { from_state: 'OPEN', to_state: 'STALE' },
      actor: 'finding-registry/sweep',
      reason: 'sweep: 30 days old',
      occurred_at: at,
    },
    [],
    anchor901,
  );
  const { prev_hash: _p, content_hash: _c, ...body } = legacyRow('ARIA-HIGH-903');
  const created = chainEvent(
    {
      finding_id: 'ARIA-HIGH-903',
      event_type: 'CREATED',
      payload: {
        ...body,
        id: 'ARIA-HIGH-903',
        state: 'OPEN',
        closed_at: null,
        closing_commits: [],
      },
      actor: 'finding-registry/add',
      reason: null,
      occurred_at: at,
    },
    [],
    tip,
  );
  const log = (id: string, events: FindingEventLine[]) =>
    [
      id,
      {
        path: eventLogRelativePath(id),
        findingId: id,
        bytes: Buffer.from(serializeEventLines(events)),
        events,
      },
    ] as const;
  return {
    genesis,
    logs: new Map([log('ARIA-HIGH-901', [stale]), log('ARIA-HIGH-903', [created])]),
  };
}

describe('finding event ledger — a pure mirror of the git registry', () => {
  it('keeps the immutable envelope and replaces its own vocabulary with a mirror check', () => {
    for (const column of [
      'event_id',
      'finding_id',
      'version',
      'event_type',
      'payload',
      'main_sha',
      'occurred_at',
      'prev_hash',
      'content_hash',
    ]) {
      expect(ledgerTable).toContain(column);
    }
    expect(ledgerTable).toContain('UNIQUE (finding_id, version)');
    expect(ledgerTable).toContain('BEFORE UPDATE OR DELETE');
    expect(ledgerTable).toContain('BEFORE TRUNCATE');

    const up = mirrorMigration.slice(
      mirrorMigration.indexOf('async up('),
      mirrorMigration.indexOf('async down('),
    );
    expect(up).toContain('DROP CONSTRAINT IF EXISTS finding_events_event_type_chk');
    expect(up).toContain('ADD CONSTRAINT finding_events_git_mirror_chk');
    for (const field of [
      'event_id',
      'finding_id',
      'version',
      'event_type',
      'prev_hash',
      'content_hash',
    ]) {
      expect(up).toContain(`payload->>'${field}'`);
    }
  });

  it('maps the entity to event_store.finding_events with the mirror check and no vocabulary', () => {
    expect(entity).toContain("@Entity({ name: 'finding_events', schema: 'event_store' })");
    expect(entity).toContain("name: 'finding_id'");
    expect(entity).toContain("name: 'event_type'");
    expect(entity).toContain("'finding_events_git_mirror_chk'");
    expect(entity).not.toContain('finding_events_event_type_chk');
    expect(entity.match(/@Check\(/g)).toHaveLength(5);
  });

  it('passes a ledger that holds exactly the git lines, and names every difference', () => {
    const store = fixtureStore();
    const lines = storeEvents(store);
    expect(lines.map((event) => `${event.finding_id}:${event.version}`)).toEqual([
      'ARIA-HIGH-901:1',
      'ARIA-HIGH-903:1',
    ]);
    // A ledger returns jsonb objects whose key order is its own.
    const reordered = lines.map(
      (event) => Object.fromEntries(Object.entries(event).reverse()) as FindingEventLine,
    );
    expect(mirrorDifferences(store, reordered)).toEqual([]);

    const [first, second] = lines as [FindingEventLine, FindingEventLine];
    expect(mirrorDifferences(store, [first])).toEqual(['ARIA-HIGH-903 v1: not mirrored']);
    expect(
      mirrorDifferences(store, [first, second, { ...second, event_id: 'f'.repeat(8) }]),
    ).toEqual(['ARIA-HIGH-903 v1: in the ledger, not in the registry']);
    expect(
      mirrorDifferences(store, [first, { ...second, occurred_at: '2026-10-26T00:00:00Z' }]),
    ).toEqual(['ARIA-HIGH-903 v1: the ledger row is not the git line']);
  });

  it('digests a registry by its genesis tip and chain heads, in any row order', () => {
    const store = fixtureStore();
    const lines = storeEvents(store);
    const tip = store.genesis[1]?.content_hash ?? '';
    expect(registryDigest(tip, [...lines].reverse())).toBe(registryDigest(tip, lines));
    expect(registryDigest(tip, lines.slice(0, 1))).not.toBe(registryDigest(tip, lines));
    expect(registryDigest('0'.repeat(64), lines)).not.toBe(registryDigest(tip, lines));
  });

  it('the registry CLI never writes the ledger', () => {
    expect(registryCli).not.toContain('event_store.finding_events');
  });
});

const MAIN_SHA = 'a'.repeat(40);
const LEDGER_COLUMNS = [
  'event_id',
  'finding_id',
  'version',
  'event_type',
  'payload',
  'main_sha',
  'occurred_at',
  'prev_hash',
  'content_hash',
];

interface InsertedRow {
  readonly [column: string]: unknown;
}

/**
 * A stand-in for the connection that records every statement and plays the
 * table's side of the INSERT: the columns are read out of the statement text
 * and paired with the bound values by position, `finding_events_git_mirror_chk`
 * is applied to the row, and the stored payload is the parsed jsonb. A
 * reordered column list, a value bound to the wrong column and a payload that
 * is not the row's own line each fail here as they would in Postgres.
 */
class RecordingLedger implements LedgerSession {
  readonly statements: { readonly text: string; readonly values: readonly unknown[] }[] = [];
  readonly inserted: InsertedRow[] = [];
  private readonly held: FindingEventLine[];

  constructor(held: readonly FindingEventLine[] = []) {
    this.held = [...held];
  }

  async query(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ readonly rows: readonly LedgerRow[] }> {
    this.statements.push({ text, values });
    if (text.startsWith('SELECT payload FROM event_store.finding_events')) {
      return { rows: this.held.map((payload) => ({ payload })) };
    }
    if (text === INSERT_FINDING_EVENT_SQL) this.insert(values);
    return { rows: [] };
  }

  private insert(values: readonly unknown[]): void {
    const listed = /\(([^)]*)\)\s*VALUES/.exec(flatSql(INSERT_FINDING_EVENT_SQL))?.[1] ?? '';
    const columns = listed.split(',').map((column) => column.trim());
    const row: Record<string, unknown> = Object.fromEntries(
      columns.map((column, index) => [column, values[index]]),
    );
    const payload = JSON.parse(String(row['payload'])) as FindingEventLine;
    const mirrors =
      payload.event_id === row['event_id'] &&
      payload.finding_id === row['finding_id'] &&
      payload.version === row['version'] &&
      payload.event_type === row['event_type'] &&
      payload.prev_hash === row['prev_hash'] &&
      payload.content_hash === row['content_hash'];
    if (!mirrors) throw new Error('violates check constraint "finding_events_git_mirror_chk"');
    this.inserted.push(row);
    this.held.push(payload);
  }

  get verbs(): string[] {
    return this.statements.map(({ text: statement }) => statement.split(/\s+/)[0] ?? '');
  }
}

/** The statement text, one line: what the column list is read from. */
function flatSql(statement: string): string {
  return statement.replace(/\s+/g, ' ');
}

/** The lines of every event log of `store`, as git holds them, in the mirror's order. */
function gitLines(store: RegistryStore): string[] {
  return [...store.logs.values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .flatMap((log) => log.bytes.toString('utf8').split('\n'))
    .filter((line) => line !== '');
}

describe("finding event ledger — the mirror's INSERT", () => {
  it('lists the nine ledger columns, in order, with one placeholder each and the payload as jsonb', () => {
    const flat = flatSql(INSERT_FINDING_EVENT_SQL);
    expect(flat).toContain(`INSERT INTO event_store.finding_events (${LEDGER_COLUMNS.join(', ')})`);
    expect(flat).toContain('VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)');
  });

  it('binds the git line verbatim as the payload and each of its fields to its own column', async () => {
    const store = fixtureStore();
    const ledger = new RecordingLedger();
    await expect(mirrorInto(ledger, store, MAIN_SHA)).resolves.toBe(2);

    expect(ledger.inserted.map((row) => row['payload'])).toEqual(gitLines(store));
    expect(ledger.inserted.map((row) => Object.keys(row))).toEqual([
      LEDGER_COLUMNS,
      LEDGER_COLUMNS,
    ]);
    const lines = storeEvents(store);
    expect(ledger.inserted).toEqual(
      lines.map((event) => ({
        event_id: event.event_id,
        finding_id: event.finding_id,
        version: event.version,
        event_type: event.event_type,
        payload: JSON.stringify(event),
        main_sha: MAIN_SHA,
        occurred_at: event.occurred_at,
        prev_hash: event.prev_hash,
        content_hash: event.content_hash,
      })),
    );
    // One transaction under the append lock: read the ledger, write the lines, commit.
    expect(ledger.verbs).toEqual(['BEGIN', 'SELECT', 'SELECT', 'INSERT', 'INSERT', 'COMMIT']);
    expect(ledger.statements[1]?.text).toContain('pg_advisory_xact_lock');
  });

  it('appends only the lines the ledger lacks, and nothing the second time', async () => {
    const store = fixtureStore();
    const [first] = storeEvents(store);
    const ledger = new RecordingLedger(first === undefined ? [] : [first]);
    await expect(mirrorInto(ledger, store, MAIN_SHA)).resolves.toBe(1);
    expect(ledger.inserted.map((row) => row['finding_id'])).toEqual(['ARIA-HIGH-903']);

    const again = new RecordingLedger(storeEvents(store));
    await expect(mirrorInto(again, store, MAIN_SHA)).resolves.toBe(0);
    expect(again.verbs).toEqual(['BEGIN', 'SELECT', 'SELECT', 'COMMIT']);
  });

  it('refuses, writes nothing and rolls back when a ledger row is not the git line with its event id', async () => {
    const store = fixtureStore();
    const [first, second] = storeEvents(store) as [FindingEventLine, FindingEventLine];
    const ledger = new RecordingLedger([first, { ...second, occurred_at: '2026-10-26T00:00:00Z' }]);
    await expect(mirrorInto(ledger, store, MAIN_SHA)).rejects.toThrow(
      /mirror refused: 1 ledger row/,
    );
    expect(ledger.inserted).toEqual([]);
    expect(ledger.verbs).toEqual(['BEGIN', 'SELECT', 'SELECT', 'ROLLBACK']);
  });

  it("the stand-in holds the table's mirror check, so a payload that is not the row's line cannot pass", async () => {
    const [event] = storeEvents(fixtureStore()) as [FindingEventLine];
    const ledger = new RecordingLedger();
    const values = [
      event.event_id,
      event.finding_id,
      event.version,
      event.event_type,
      JSON.stringify({ ...event, content_hash: 'f'.repeat(64) }),
      MAIN_SHA,
      event.occurred_at,
      event.prev_hash,
      event.content_hash,
    ];
    await expect(ledger.query(INSERT_FINDING_EVENT_SQL, values)).rejects.toThrow(
      /finding_events_git_mirror_chk/,
    );
    expect(ledger.inserted).toEqual([]);
  });
});
