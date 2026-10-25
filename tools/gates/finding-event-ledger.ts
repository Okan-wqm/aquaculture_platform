#!/usr/bin/env ts-node
/**
 * finding-event-ledger — the Postgres `event_store.finding_events` ledger as a
 * pure mirror of the git event store (MF-DESIGN §9 Q2, DATA-HIGH-011).
 *
 * WHY. The ledger had its own envelope, its own vocabulary (event types the
 * registry never had, a STATE_TRANSITIONED that could reach RESOLVED) and its own copy of
 * canonicalJson, and bootstrapped itself from findings.jsonl as if that file
 * were the authority. With MF-2 the authority is the registry in git: a
 * frozen genesis segment plus one append-only event log per finding
 * (finding-registry-events.ts). Two vocabularies for one concept would
 * disagree the first time either changed, so the ledger keeps none: each row
 * is one git event line, verbatim, in `payload`, and its other columns are
 * that line's own fields (a CHECK constraint holds them equal), plus the
 * commit the mirror read it at.
 *
 * WHAT.
 *   mirror MAIN_SHA          — append every event line the registry holds at
 *                              MAIN_SHA (a commit of origin/main) that the
 *                              ledger lacks; refuse when a ledger row differs
 *                              from the line with its event id (the ledger is
 *                              append-only, like the logs it mirrors).
 *   parity MAIN_SHA [--record]
 *                            — the registry at MAIN_SHA against the ledger:
 *                              every line mirrored verbatim, nothing extra,
 *                              and the fold of the ledger's events over the
 *                              genesis segment equal to the projection's
 *                              fold (finding-registry-projection.ts). With
 *                              --record the run is kept in
 *                              finding_ledger_parity_runs.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { Client, type ClientConfig } from 'pg';

import { canonicalJson, sha256hex } from './finding-registry-chain';
import { type FindingEventLine, serializeEventLines } from './finding-registry-events';
import {
  eventLogRelativePath,
  foldRegistry,
  readRegistryStoreAt,
  type RegistryStore,
} from './finding-registry-projection';
import { commitReachableFrom } from './git-reachability';

const REPO_ROOT = resolve(__dirname, '..', '..');
/** Serialises every ledger writer: one mirror or recorded parity run at a time. */
const LEDGER_APPEND_LOCK = 'event_store.finding_events.append';

/** Every event line the store holds, in (finding, version) order. */
export function storeEvents(store: RegistryStore): FindingEventLine[] {
  return [...store.logs.values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .flatMap((log) => log.events);
}

/**
 * The digest of a registry: its genesis tip and the head of every finding's
 * chain. A chain head commits to every line before it, so two stores with
 * the same digest hold the same events.
 */
export function registryDigest(genesisTip: string, events: readonly FindingEventLine[]): string {
  const heads: Record<string, { version: number; content_hash: string }> = {};
  for (const event of events) {
    const head = heads[event.finding_id];
    if (head === undefined || event.version > head.version) {
      heads[event.finding_id] = { version: event.version, content_hash: event.content_hash };
    }
  }
  return sha256hex(canonicalJson({ genesis_tip: genesisTip, heads }));
}

/** The store `events` make over `store`'s genesis segment: what the ledger holds, as git would. */
export function storeOf(store: RegistryStore, events: readonly FindingEventLine[]): RegistryStore {
  const byFinding = new Map<string, FindingEventLine[]>();
  for (const event of [...events].sort(
    (left, right) =>
      left.finding_id.localeCompare(right.finding_id) || left.version - right.version,
  )) {
    byFinding.set(event.finding_id, [...(byFinding.get(event.finding_id) ?? []), event]);
  }
  return {
    genesis: store.genesis,
    logs: new Map(
      [...byFinding].map(([findingId, lines]) => [
        findingId,
        {
          path: eventLogRelativePath(findingId),
          findingId,
          bytes: Buffer.from(serializeEventLines(lines)),
          events: lines,
        },
      ]),
    ),
  };
}

/**
 * Where the ledger and the registry disagree: a line not mirrored, a row the
 * registry does not hold, a row that is not its line verbatim, and a fold of
 * the ledger's events that differs from the projection's fold of the logs.
 */
export function mirrorDifferences(
  store: RegistryStore,
  ledger: readonly FindingEventLine[],
): string[] {
  const differences: string[] = [];
  const git = new Map(storeEvents(store).map((event) => [event.event_id, event]));
  const mirrored = new Map(ledger.map((event) => [event.event_id, event]));
  for (const [id, event] of git) {
    const row = mirrored.get(id);
    if (row === undefined) differences.push(`${event.finding_id} v${event.version}: not mirrored`);
    else if (canonicalJson(row) !== canonicalJson(event)) {
      differences.push(`${event.finding_id} v${event.version}: the ledger row is not the git line`);
    }
  }
  for (const [id, row] of mirrored) {
    if (!git.has(id)) {
      differences.push(`${row.finding_id} v${row.version}: in the ledger, not in the registry`);
    }
  }
  if (differences.length > 0) return differences;
  const expected = foldRegistry(store);
  const actual = foldRegistry(storeOf(store, ledger));
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    differences.push('the ledger folds to rows the projection does not');
  }
  return differences;
}

function databaseConfig(): ClientConfig {
  return {
    host: process.env.DATABASE_HOST ?? 'localhost',
    port: Number.parseInt(process.env.DATABASE_PORT ?? '5432', 10),
    user: process.env.DATABASE_USER ?? 'event_store_service',
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME ?? 'aquaculture',
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false,
  };
}

/** The registry at `mainSha`, refused unless `mainSha` is a full SHA on origin/main. */
function registryAtMain(mainSha: string): RegistryStore {
  if (!/^[0-9a-f]{40}$/.test(mainSha)) {
    throw new Error('main SHA must be 40 lowercase hex characters');
  }
  const reachability = commitReachableFrom(REPO_ROOT, mainSha, 'origin/main');
  if (!reachability.ok) throw new Error(`main SHA rejected: ${reachability.reason}`);
  return readRegistryStoreAt(REPO_ROOT, mainSha);
}

async function readLedger(client: Client): Promise<FindingEventLine[]> {
  const result = await client.query<{ payload: FindingEventLine }>(
    `SELECT payload FROM event_store.finding_events ORDER BY ledger_seq ASC`,
  );
  return result.rows.map((row) => row.payload);
}

async function acquireAppendLock(client: Client): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LEDGER_APPEND_LOCK]);
}

async function mirror(mainSha: string): Promise<void> {
  const store = registryAtMain(mainSha);
  const client = new Client(databaseConfig());
  await client.connect();
  try {
    await client.query('BEGIN');
    await acquireAppendLock(client);
    const ledger = await readLedger(client);
    const git = new Map(storeEvents(store).map((event) => [event.event_id, event]));
    const foreign = ledger.filter(
      (row) =>
        git.get(row.event_id) === undefined ||
        canonicalJson(git.get(row.event_id)) !== canonicalJson(row),
    );
    if (foreign.length > 0) {
      throw new Error(
        `mirror refused: ${foreign.length} ledger row(s) are not git lines at ${mainSha} ` +
          `(${foreign.map((row) => `${row.finding_id} v${row.version}`).join(', ')})`,
      );
    }
    const known = new Set(ledger.map((row) => row.event_id));
    const missing = storeEvents(store).filter((event) => !known.has(event.event_id));
    for (const event of missing) {
      await client.query(
        `INSERT INTO event_store.finding_events
           (event_id, finding_id, version, event_type, payload, main_sha,
            occurred_at, prev_hash, content_hash)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,
        [
          event.event_id,
          event.finding_id,
          event.version,
          event.event_type,
          JSON.stringify(event),
          mainSha,
          event.occurred_at,
          event.prev_hash,
          event.content_hash,
        ],
      );
    }
    await client.query('COMMIT');
    process.stdout.write(`mirrored ${missing.length} git event line(s) at ${mainSha}\n`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

async function parity(mainSha: string, record: boolean): Promise<number> {
  const store = registryAtMain(mainSha);
  const client = new Client(databaseConfig());
  await client.connect();
  try {
    if (record) {
      await client.query('BEGIN');
      await acquireAppendLock(client);
    }
    const ledger = await readLedger(client);
    const differences = mirrorDifferences(store, ledger);
    const genesisTip = store.genesis[store.genesis.length - 1]?.content_hash ?? '0'.repeat(64);
    const result = {
      passed: differences.length === 0,
      differences,
      registryTip: registryDigest(genesisTip, storeEvents(store)),
      ledgerTip: registryDigest(genesisTip, ledger),
      registryEvents: storeEvents(store).length,
      ledgerEvents: ledger.length,
    };
    if (record) {
      await client.query(
        `INSERT INTO event_store.finding_ledger_parity_runs
           (run_id, main_sha, registry_tip_hash, ledger_tip_hash,
            registry_entries, ledger_findings, passed, checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp())`,
        [
          randomUUID(),
          mainSha,
          result.registryTip,
          result.ledgerTip,
          result.registryEvents,
          result.ledgerEvents,
          result.passed,
        ],
      );
      await client.query('COMMIT');
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.passed ? 0 : 1;
  } catch (error) {
    if (record) await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const [, , command, mainSha, ...args] = process.argv;
  if (command === 'mirror' && mainSha && args.length === 0) {
    await mirror(mainSha);
    return;
  }
  if (command === 'parity' && mainSha) {
    process.exitCode = await parity(mainSha, args.includes('--record'));
    return;
  }
  process.stderr.write(
    'Usage: finding-event-ledger <mirror MAIN_SHA|parity MAIN_SHA [--record]>\n',
  );
  process.exitCode = 2;
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
