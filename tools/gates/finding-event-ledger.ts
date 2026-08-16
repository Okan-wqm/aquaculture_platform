#!/usr/bin/env ts-node
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Client, type ClientConfig } from 'pg';

import {
  type FindingCreatedPayload,
  type FindingEvent,
  type FindingProjection,
  FINDING_EVENT_APPEND_LOCK_NAMESPACE,
  FINDING_EVENT_ZERO_HASH,
  canonicalJson,
  computeFindingEventHash,
  replayFindingEvents,
} from '../../libs/backend-common/src/finding-registry/finding-event';
import { commitReachableFrom, repoPinnedEnv } from './git-reachability';

const REPO_ROOT = resolve(__dirname, '..', '..');
const REGISTRY_PATH = resolve(REPO_ROOT, 'docs/reviews/_registry/findings.jsonl');

export interface RegistrySnapshot {
  id: string;
  severity: FindingCreatedPayload['severity'];
  state: FindingCreatedPayload['state'];
  title: string;
  layer: FindingCreatedPayload['layer'];
  owner_agent: string;
  raised_in_cycle: string;
  review_file?: string;
  evidence?: string[];
  rule_violated?: string;
  notes?: string;
  narrative?: string[];
  deadline: string | null;
  owner_user: string | null;
  override_of: string | null;
  closing_commits: string[];
  created_at: string;
  closed_at: string | null;
  content_hash: string;
}

interface ParityResult {
  passed: boolean;
  differences: string[];
  registryTip: string;
  ledgerTip: string;
  registryEntries: number;
  ledgerFindings: number;
}

export interface RecordedParityCycle {
  passed: boolean;
  registry_tip_hash: string;
  ledger_tip_hash: string;
  main_sha: string;
}

export function isCutoverReady(
  expectedRegistryTip: string,
  currentLedgerTip: string,
  currentDifferences: readonly string[],
  cycles: readonly RecordedParityCycle[],
): boolean {
  return (
    currentDifferences.length === 0 &&
    cycles.length === 2 &&
    cycles.every(
      (cycle) =>
        cycle.passed &&
        cycle.registry_tip_hash === expectedRegistryTip &&
        cycle.ledger_tip_hash === currentLedgerTip,
    ) &&
    cycles[0]!.main_sha !== cycles[1]!.main_sha
  );
}

export function buildBootstrapEvents(
  snapshots: readonly RegistrySnapshot[],
  mainSha: string,
): FindingEvent<'CREATED'>[] {
  let prevHash = FINDING_EVENT_ZERO_HASH;
  return snapshots.map((snapshot) => {
    const event: FindingEvent<'CREATED'> = {
      event_id: deterministicUuid(`${snapshot.id}:${snapshot.content_hash}`),
      finding_id: snapshot.id,
      version: 1,
      event_type: 'CREATED',
      payload: snapshotPayload(snapshot),
      main_sha: mainSha,
      occurred_at: new Date(snapshot.created_at).toISOString(),
      prev_hash: prevHash,
      content_hash: '',
    };
    event.content_hash = computeFindingEventHash(event);
    prevHash = event.content_hash;
    return event;
  });
}

function deterministicUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function snapshotPayload(snapshot: RegistrySnapshot): FindingCreatedPayload {
  return {
    severity: snapshot.severity,
    state: snapshot.state,
    title: snapshot.title,
    layer: snapshot.layer,
    owner_agent: snapshot.owner_agent,
    raised_in_cycle: snapshot.raised_in_cycle,
    review_file: snapshot.review_file ?? null,
    evidence: snapshot.evidence ?? [],
    rule_violated: snapshot.rule_violated ?? null,
    notes: snapshot.notes ?? null,
    narrative: snapshot.narrative ?? [],
    deadline: snapshot.deadline,
    owner_user: snapshot.owner_user,
    override_of: snapshot.override_of,
    closing_commits: snapshot.closing_commits,
    created_at: snapshot.created_at,
    closed_at: snapshot.closed_at,
  };
}

function loadSnapshots(): RegistrySnapshot[] {
  const raw = readFileSync(REGISTRY_PATH, 'utf8').trim();
  return raw.length === 0
    ? []
    : raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RegistrySnapshot);
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

async function bootstrap(mainSha: string): Promise<void> {
  const snapshots = loadSnapshots();
  assertMainSha(mainSha, registryTip(snapshots));
  const events = buildBootstrapEvents(snapshots, mainSha);
  const client = new Client(databaseConfig());
  await client.connect();
  try {
    await client.query('BEGIN');
    await acquireAppendLock(client);
    const existing = await readEvents(client);
    if (existing.length > 0) {
      if (canonicalJson(existing) !== canonicalJson(events)) {
        throw new Error(
          'bootstrap refused: finding_events is non-empty and differs from deterministic replay',
        );
      }
      await client.query('ROLLBACK');
      process.stdout.write(`bootstrap already complete (${existing.length} events)\n`);
      return;
    }
    for (const event of events) {
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
          JSON.stringify(event.payload),
          event.main_sha,
          event.occurred_at,
          event.prev_hash,
          event.content_hash,
        ],
      );
    }
    await client.query('COMMIT');
    process.stdout.write(`bootstrapped ${events.length} immutable finding events\n`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

async function parity(mainSha: string, record: boolean): Promise<number> {
  const snapshots = loadSnapshots();
  assertMainSha(mainSha, registryTip(snapshots));
  const client = new Client(databaseConfig());
  await client.connect();
  try {
    if (record) {
      await client.query('BEGIN');
      await acquireAppendLock(client);
    }
    const events = await readEvents(client);
    const replay = replayFindingEvents(events);
    const differences = compareSnapshots(snapshots, replay.findings);
    const result: ParityResult = {
      passed: differences.length === 0,
      differences,
      registryTip: snapshots.at(-1)?.content_hash ?? FINDING_EVENT_ZERO_HASH,
      ledgerTip: replay.chain_tip,
      registryEntries: snapshots.length,
      ledgerFindings: replay.findings.size,
    };
    if (record) await recordParity(client, mainSha, result);
    if (record) await client.query('COMMIT');
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.passed ? 0 : 1;
  } catch (error) {
    if (record) await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

async function cutoverReady(): Promise<number> {
  const snapshots = loadSnapshots();
  const expectedTip = registryTip(snapshots);
  const client = new Client(databaseConfig());
  await client.connect();
  try {
    await client.query('BEGIN');
    await acquireAppendLock(client);
    const events = await readEvents(client);
    const replay = replayFindingEvents(events);
    const differences = compareSnapshots(snapshots, replay.findings);
    const result = await client.query<RecordedParityCycle>(
      `SELECT passed, registry_tip_hash, ledger_tip_hash, main_sha
         FROM event_store.finding_ledger_parity_runs
        ORDER BY parity_seq DESC
        LIMIT 2`,
    );
    const ready = isCutoverReady(expectedTip, replay.chain_tip, differences, result.rows);
    await client.query('COMMIT');
    process.stdout.write(
      `${JSON.stringify(
        {
          ready,
          required_cycles: 2,
          current_registry_tip: expectedTip,
          current_ledger_tip: replay.chain_tip,
          current_differences: differences,
          observed_cycles: result.rows,
        },
        null,
        2,
      )}\n`,
    );
    return ready ? 0 : 1;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

async function readEvents(client: Client): Promise<FindingEvent[]> {
  const result = await client.query<{
    event_id: string;
    finding_id: string;
    version: number;
    event_type: FindingEvent['event_type'];
    payload: FindingEvent['payload'];
    main_sha: string;
    occurred_at: Date;
    prev_hash: string;
    content_hash: string;
  }>(
    `SELECT event_id, finding_id, version, event_type, payload, main_sha,
            occurred_at, prev_hash, content_hash
       FROM event_store.finding_events
      ORDER BY ledger_seq ASC`,
  );
  return result.rows.map((row) => ({
    ...row,
    occurred_at: row.occurred_at.toISOString(),
  }));
}

function compareSnapshots(
  snapshots: readonly RegistrySnapshot[],
  findings: ReadonlyMap<string, FindingProjection>,
): string[] {
  const differences: string[] = [];
  if (snapshots.length !== findings.size) {
    differences.push(`cardinality registry=${snapshots.length} ledger=${findings.size}`);
  }
  for (const snapshot of snapshots) {
    const projection = findings.get(snapshot.id);
    if (!projection) {
      differences.push(`${snapshot.id}: missing from ledger`);
      continue;
    }
    const expected = snapshotPayload(snapshot);
    const actual: FindingCreatedPayload = {
      severity: projection.severity,
      state: projection.state,
      title: projection.title,
      layer: projection.layer,
      owner_agent: projection.owner_agent,
      raised_in_cycle: projection.raised_in_cycle,
      review_file: projection.review_file,
      evidence: projection.evidence,
      rule_violated: projection.rule_violated,
      notes: projection.notes,
      narrative: projection.narrative,
      deadline: projection.deadline,
      owner_user: projection.owner_user,
      override_of: projection.override_of,
      closing_commits: projection.closing_commits,
      created_at: projection.created_at,
      closed_at: projection.closed_at,
    };
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      differences.push(`${snapshot.id}: projection differs from JSONL authority`);
    }
  }
  return differences;
}

async function recordParity(client: Client, mainSha: string, result: ParityResult): Promise<void> {
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
      result.registryEntries,
      result.ledgerFindings,
      result.passed,
    ],
  );
}

function registryTip(snapshots: readonly RegistrySnapshot[]): string {
  return snapshots.at(-1)?.content_hash ?? FINDING_EVENT_ZERO_HASH;
}

function registryTipAtCommit(mainSha: string): string {
  const raw = execFileSync(
    'git',
    ['-C', REPO_ROOT, 'show', `${mainSha}:docs/reviews/_registry/findings.jsonl`],
    { encoding: 'utf8', env: repoPinnedEnv(), maxBuffer: 64 * 1024 * 1024 },
  ).trim();
  if (raw.length === 0) return FINDING_EVENT_ZERO_HASH;
  const lastLine = raw.split(/\r?\n/).at(-1);
  if (!lastLine) throw new Error(`registry at ${mainSha} has no readable final entry`);
  const snapshot = JSON.parse(lastLine) as Pick<RegistrySnapshot, 'content_hash'>;
  return snapshot.content_hash;
}

function assertMainSha(mainSha: string, expectedRegistryTip: string): void {
  if (!/^[0-9a-f]{40}$/.test(mainSha))
    throw new Error('main SHA must be 40 lowercase hex characters');
  const reachability = commitReachableFrom(REPO_ROOT, mainSha, 'origin/main');
  if (!reachability.ok) throw new Error(`main SHA rejected: ${reachability.reason}`);
  const committedTip = registryTipAtCommit(mainSha);
  if (committedTip !== expectedRegistryTip) {
    throw new Error(
      `main SHA rejected: registry tip at ${mainSha} is ${committedTip}, local authority is ${expectedRegistryTip}`,
    );
  }
}

async function acquireAppendLock(client: Client): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    FINDING_EVENT_APPEND_LOCK_NAMESPACE,
  ]);
}

async function main(): Promise<void> {
  const [, , command, mainSha, ...args] = process.argv;
  if (command === 'bootstrap' && mainSha) {
    await bootstrap(mainSha);
    return;
  }
  if (command === 'parity' && mainSha) {
    process.exitCode = await parity(mainSha, args.includes('--record'));
    return;
  }
  if (command === 'cutover-ready') {
    process.exitCode = await cutoverReady();
    return;
  }
  process.stderr.write(
    'Usage: finding-event-ledger <bootstrap MAIN_SHA|parity MAIN_SHA [--record]|cutover-ready>\n',
  );
  process.exitCode = 2;
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
