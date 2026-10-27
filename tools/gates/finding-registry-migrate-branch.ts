#!/usr/bin/env ts-node
/**
 * finding-registry-migrate-branch — convert a branch that wrote findings.jsonl
 * before the MF-2 freeze into per-finding events (MF-DESIGN §6 step 4).
 *
 * ## Why
 *
 * From MF-2 on, findings.jsonl is the frozen genesis segment genesis.json
 * pins, and `finding-registry verify` refuses a branch whose copy differs.
 * Branches opened before the freeze (ARIA landing PRs, registration PRs)
 * appended rows and edited legacy rows in place. Re-entering each change by
 * hand is the slip the registry exists to prevent, so this command replays
 * them as the events the CLI would have written.
 *
 * ## What it does
 *
 * Run from the branch, with `--base` naming the commit that carries the
 * freeze (`origin/main`):
 *
 *   1. the frozen segment is findings.jsonl at `--base`, and it must be the
 *      one `--base`'s genesis.json pins;
 *   2. the branch's change is its findings.jsonl against the merge-base of
 *      HEAD and `--base` (the rows the branch started from), so a branch that
 *      has not merged the freeze yet converts as well as one that has;
 *   3. each new row becomes a CREATED event (born OPEN or IN-PROGRESS; a
 *      later STALE/BLOCKED is a STATE_TRANSITIONED after it); each changed
 *      legacy row becomes CLOSURE_REJECTED / STATE_TRANSITIONED /
 *      OWNER_ASSIGNED / AMENDED events, in that order;
 *   4. RESOLVED edits are dropped: the branch's merged `Closes:` trailer
 *      derives them (MF-1);
 *   5. findings.jsonl and genesis.json are restored to `--base`'s bytes, and
 *      the events are appended through the registry's one sink.
 *
 * It is deterministic (event ids are name-based, `occurred_at` is the date of
 * the branch's last commit that wrote findings.jsonl) and allocates no id. A
 * change no event can express (a deleted row, a re-dated deadline, an edited
 * identity field) is refused, and nothing is written. Every check runs before
 * the first write.
 *
 * MF-3 retires this command once no open PR touches findings.jsonl (the
 * tracked finding the event store records).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveGitFindingAllocationAuthority } from './finding-registry';
import { canonicalJson, type Finding, parseRegistryJsonl } from './finding-registry-chain';
import {
  appendFindingEvents,
  type CreatedPayload,
  type FindingEventDraft,
  genesisPin,
  isCreatedState,
  isGitStateTarget,
  planFindingEvents,
  serializeGenesisPin,
} from './finding-registry-events';
import {
  AMENDABLE_FIELDS,
  applyFindingEvent,
  GENESIS_PIN_RELATIVE_PATH,
  readRegistryStoreIn,
  REGISTRY_RELATIVE_PATH,
  registryDir,
  registryLayout,
  type RegistryStore,
  rowAfterClosureRejection,
} from './finding-registry-projection';
import { RegistryWriteRefused } from './finding-registry-rows';
import {
  atomicWriteFileWithRegistryLease,
  RegistryLockError,
  withRegistryFileLock,
} from './finding-registry-store';
import { repoPinnedEnv } from './git-reachability';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ACTOR = 'finding-registry-migrate-branch';
const REASON =
  "converted from this branch's findings.jsonl edit when the registry froze (MF-2), by " +
  'finding-registry-migrate-branch';

/** The chain fields a rechain rewrites; never a change of the finding. */
const CHAIN_FIELDS = new Set(['prev_hash', 'content_hash']);
/** Fields a closure writes; a RESOLVED edit is derived, so they are dropped with it. */
const CLOSURE_FIELDS = new Set(['state', 'closing_commits', 'closed_at']);
const ASSIGNABLE_FIELDS = new Set(['owner_user', 'deadline']);

function git(args: readonly string[]): Buffer {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], {
    env: repoPinnedEnv(),
    maxBuffer: 256 * 1024 * 1024,
  });
}

function gitText(args: readonly string[]): string {
  return git(args).toString('utf8').trim();
}

function present(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left ?? null) === canonicalJson(right ?? null);
}

/** The finding as a CREATED payload: the row without its chain fields, born unclosed. */
function createdPayload(row: Finding): CreatedPayload {
  const body = Object.fromEntries(
    Object.entries(row).filter(([field]) => !CHAIN_FIELDS.has(field)),
  );
  return {
    ...body,
    id: row.id,
    state: isCreatedState(row.state) ? row.state : 'OPEN',
    closed_at: null,
    closing_commits: [],
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What the conversion decides of an event; the finding, actor, reason and time are the run's. */
type Draft = DistributiveOmit<FindingEventDraft, 'finding_id' | 'actor' | 'reason' | 'occurred_at'>;

/** The events of a finding born on the branch. */
function newFindingEvents(row: Finding): Draft[] {
  const drafts: Draft[] = [{ event_type: 'CREATED', payload: createdPayload(row) }];
  // A finding the branch recorded STALE or BLOCKED is born OPEN and moved there;
  // one it recorded RESOLVED stays OPEN until its merged trailer derives the closure.
  if (!isCreatedState(row.state) && isGitStateTarget(row.state)) {
    drafts.push({
      event_type: 'STATE_TRANSITIONED',
      payload: { from_state: 'OPEN', to_state: row.state },
    });
  }
  return drafts;
}

/**
 * The events that take `current` (the frozen row with its recorded events)
 * to what the branch made of `forked` (the row it started from). Refuses a
 * change no event can express.
 *
 * A state change is decided against the row the rejection leaves: rejecting
 * a recorded closure already reopens a RESOLVED row (the pre-freeze
 * `reopen --reject-closure` wrote state OPEN beside the rejected closer), so
 * the branch's OPEN is then no transition, and any other target transitions
 * from the state the rejection left, not from the one the frozen row recorded.
 */
function changedFindingEvents(current: Finding, forked: Finding, branch: Finding): Draft[] {
  const changed = new Set(
    [...new Set([...Object.keys(forked), ...Object.keys(branch)])].filter(
      (field) => !CHAIN_FIELDS.has(field) && !same(forked[field], branch[field]),
    ),
  );
  const drafts: Draft[] = [];
  const unexpressible = [...changed].filter(
    (field) =>
      !CLOSURE_FIELDS.has(field) &&
      !ASSIGNABLE_FIELDS.has(field) &&
      field !== 'rejected_closing_commits' &&
      !(AMENDABLE_FIELDS as readonly string[]).includes(field),
  );
  if (unexpressible.length > 0) {
    throw new RegistryWriteRefused([
      `${branch.id}: the branch changed ${unexpressible.join(', ')}, which no event records ` +
        '(an identity field, or a field only a new finding sets)',
    ]);
  }

  let reached = current;
  if (changed.has('rejected_closing_commits')) {
    const before = forked.rejected_closing_commits ?? [];
    const shas = (branch.rejected_closing_commits ?? []).filter((sha) => !before.includes(sha));
    if (shas.length > 0) {
      drafts.push({ event_type: 'CLOSURE_REJECTED', payload: { shas } });
      reached = rowAfterClosureRejection(current, shas);
    }
  }

  // A state the branch wrote is kept unless it is RESOLVED: a closure is the
  // branch's merged trailer, which the projection derives.
  if (changed.has('state') && isGitStateTarget(branch.state) && reached.state !== branch.state) {
    drafts.push({
      event_type: 'STATE_TRANSITIONED',
      payload: { from_state: reached.state, to_state: branch.state },
    });
  }

  const assigned: { owner_user?: string; deadline?: string } = {};
  const amended: Record<string, unknown> = {};
  for (const field of ['owner_user', 'deadline'] as const) {
    if (!changed.has(field)) continue;
    const value = branch[field];
    if (typeof value !== 'string') {
      throw new RegistryWriteRefused([`${branch.id}: the branch cleared ${field}`]);
    }
    if (!present(forked[field])) assigned[field] = value;
    else if (field === 'owner_user') amended[field] = value;
    else {
      throw new RegistryWriteRefused([
        `${branch.id}: the branch re-dated deadline ${String(forked[field])} -> ${value}; ` +
          're-dating a finding is an override decision, not a conversion',
      ]);
    }
  }
  if (Object.keys(assigned).length > 0) {
    drafts.push({ event_type: 'OWNER_ASSIGNED', payload: assigned });
  }
  for (const field of AMENDABLE_FIELDS) {
    if (field !== 'owner_user' && changed.has(field)) amended[field] = branch[field];
  }
  if (Object.keys(amended).length > 0) {
    // The event schema holds each amended field to the row contract's shape.
    drafts.push({ event_type: 'AMENDED', payload: { fields: amended } });
  }
  return drafts;
}

/** The fold of `store`, keyed by id. */
function foldedById(store: RegistryStore): Map<string, Finding> {
  const rows = new Map(store.genesis.map((row) => [row.id, { ...row }]));
  for (const log of store.logs.values()) {
    const base = rows.get(log.findingId);
    if (base === undefined) continue;
    rows.set(log.findingId, log.events.reduce(applyFindingEvent, base));
  }
  return rows;
}

interface Conversion {
  readonly frozen: Buffer;
  readonly pin: Buffer;
  readonly drafts: FindingEventDraft[];
}

/** Everything the conversion will write, decided before anything is. */
function planConversion(base: string): Conversion {
  const frozen = git(['show', `${base}:${REGISTRY_RELATIVE_PATH}`]);
  const pin = git(['show', `${base}:${GENESIS_PIN_RELATIVE_PATH}`]);
  if (!pin.equals(Buffer.from(serializeGenesisPin(genesisPin(frozen))))) {
    throw new RegistryWriteRefused([
      `${base} does not carry a frozen findings.jsonl: its ${GENESIS_PIN_RELATIVE_PATH} does ` +
        'not pin its findings.jsonl. Pass the commit that carries the freeze (origin/main).',
    ]);
  }
  const mergeBase = gitText(['merge-base', 'HEAD', base]);
  const forkedRows = parseRegistryJsonl(
    git(['show', `${mergeBase}:${REGISTRY_RELATIVE_PATH}`]).toString('utf8'),
  );
  const layout = registryLayout(registryDir(REPO_ROOT));
  const branchRows = parseRegistryJsonl(readFileSync(layout.genesisPath, 'utf8'));
  const store: RegistryStore = {
    ...readRegistryStoreIn(layout.dir),
    genesis: parseRegistryJsonl(frozen.toString('utf8')),
  };
  const current = foldedById(store);
  const forked = new Map(forkedRows.map((row) => [row.id, row]));
  const onBranch = new Set(branchRows.map((row) => row.id));
  const deleted = forkedRows.filter((row) => !onBranch.has(row.id)).map((row) => row.id);
  if (deleted.length > 0) {
    throw new RegistryWriteRefused([
      `the branch deleted ${deleted.join(', ')} from findings.jsonl; a finding is never deleted`,
    ]);
  }

  const occurredAt =
    gitText(['log', '-1', '--format=%cI', `${mergeBase}..HEAD`, '--', REGISTRY_RELATIVE_PATH]) ||
    gitText(['show', '-s', '--format=%cI', 'HEAD']);
  const occurred_at = new Date(occurredAt).toISOString();
  const drafts: FindingEventDraft[] = [];
  for (const row of branchRows) {
    const from = forked.get(row.id);
    const events =
      from === undefined
        ? newFindingEvents(row)
        : changedFindingEvents(current.get(row.id) ?? from, from, row);
    for (const event of events) {
      drafts.push({
        ...event,
        finding_id: row.id,
        actor: ACTOR,
        reason: event.event_type === 'CREATED' ? null : REASON,
        occurred_at,
      } as FindingEventDraft);
    }
  }
  // The same checks the sink runs, against the frozen segment: a conversion
  // the registry would refuse is refused before findings.jsonl is restored.
  planFindingEvents(layout, store, drafts);
  return { frozen, pin, drafts };
}

function main(): number {
  const args = process.argv.slice(2);
  const base = args.find((arg) => arg.startsWith('--base='))?.slice('--base='.length);
  if (base === undefined || base === '' || args.length !== 1) {
    process.stderr.write(
      'usage: finding-registry-migrate-branch --base=<rev carrying the freeze>\n',
    );
    return 2;
  }
  const layout = registryLayout(registryDir(REPO_ROOT));
  try {
    const authority = resolveGitFindingAllocationAuthority(REPO_ROOT);
    return withRegistryFileLock(
      layout.dir,
      (lease) => {
        const conversion = planConversion(base);
        atomicWriteFileWithRegistryLease(
          layout.genesisPath,
          conversion.frozen.toString('utf8'),
          lease,
        );
        atomicWriteFileWithRegistryLease(layout.pinPath, conversion.pin.toString('utf8'), lease);
        const written = appendFindingEvents(layout, conversion.drafts, lease);
        process.stdout.write(
          `Restored findings.jsonl to ${base}'s frozen segment; ${conversion.drafts.length} ` +
            `event(s) in ${written.length} log(s):\n`,
        );
        for (const path of written) process.stdout.write(`  ${path}\n`);
        return 0;
      },
      { lockPath: authority.lockPath },
    );
  } catch (error) {
    if (error instanceof RegistryWriteRefused || error instanceof RegistryLockError) {
      process.stderr.write(`migrate-branch refused: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

if (require.main === module) process.exitCode = main();
