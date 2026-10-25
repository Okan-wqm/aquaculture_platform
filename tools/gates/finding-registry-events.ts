/**
 * finding-registry-events — the registry's write side (MF-2): one append-only
 * event log per finding, and findings.jsonl frozen as a pinned genesis segment.
 *
 * ## Why
 *
 * Every registry writer used to rewrite one hash-chained findings.jsonl: a new
 * finding at its end, a decision by editing a past row and rechaining every
 * row after it. Two branches that each recorded a finding therefore changed
 * the same lines, and GitHub, which runs no merge driver, marked the second PR
 * DIRTY (141 conflicted syncs across 53 PRs in 14 days; MF-DESIGN §1). Here a
 * writer appends one line to `findings/<PREFIX>/<ID>.jsonl`, so two findings
 * are two paths and only two decisions about the same finding conflict — the
 * one conflict that carries information.
 *
 * ## What it owns
 *
 *   - the closed event vocabulary (`GIT_FINDING_EVENT_TYPES`, the TypeScript
 *     mirror of finding-event.schema.json). `GitStateTarget` excludes
 *     RESOLVED, so a RESOLVED write is a compile error at every writer;
 *     RESOLVED is derived from merged `Closes:` trailers by the projection;
 *   - the per-finding chain: line 1 anchors on the finding's genesis row (or
 *     the genesis tip for a finding born after the freeze), line n on line
 *     n−1, `content_hash = sha256(canonicalJson(line − content_hash))` with the
 *     one canonicalJson of finding-registry-chain.ts;
 *   - the one write sink, `appendFindingEvents`: event schema, the fold
 *     (finding-registry-projection.ts `foldRegistry`), the row contract on
 *     every row it changes (finding-registry-rows.ts) and the owner rule, then
 *     an fsync-and-rename of each file under the registry lease;
 *   - the genesis pin (`genesisPin`, `pinGenesis`) and the store verifier
 *     (`registryDefects`, `appendOnlyDefects`).
 *
 * The store layout and the fold belong to the projection, the one reader;
 * this module reads through it. The Postgres finding_events ledger mirrors
 * these lines verbatim (finding-event-ledger.ts), so the repository has one
 * event vocabulary.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  canonicalJson,
  chainTip,
  type Finding,
  type FindingState,
  isUnresolvedFindingState,
  parseRegistryJsonl,
  sha256hex,
  verify,
} from './finding-registry-chain';
import { ownerViolations } from './finding-registry-owners';
import {
  EVENT_STORE_RELATIVE_PATH,
  eventLogRelativePath,
  foldRegistry,
  GENESIS_PIN_RELATIVE_PATH,
  readRegistryStoreIn,
  REGISTRY_RELATIVE_PATH,
  type RegistryLayout,
  type RegistrySnapshot,
  type RegistryStore,
} from './finding-registry-projection';
import { RegistryWriteRefused, rowContractViolations } from './finding-registry-rows';
import { atomicWriteFileWithRegistryLease, type RegistryLockLease } from './finding-registry-store';
import { repoPinnedEnv } from './git-reachability';

/**
 * Every state an event may move a finding to: RESOLVED is derived, never
 * written. The set is the registry's unresolved states, so the one predicate
 * of finding-registry-chain.ts answers for it.
 */
export type GitStateTarget = Exclude<FindingState, 'RESOLVED'>;

export function isGitStateTarget(state: string): state is GitStateTarget {
  return isUnresolvedFindingState(state);
}

/** A finding is born OPEN or IN-PROGRESS, with no closure; STALE and BLOCKED are later judgements. */
export const CREATED_STATES = ['OPEN', 'IN-PROGRESS'] as const satisfies readonly GitStateTarget[];
export type CreatedState = (typeof CREATED_STATES)[number];

export function isCreatedState(state: string): state is CreatedState {
  return (CREATED_STATES as readonly string[]).includes(state);
}

/** The row body a CREATED event carries: the row minus its chain fields. */
export interface CreatedPayload {
  readonly id: string;
  readonly state: CreatedState;
  readonly closed_at: null;
  readonly closing_commits: readonly string[];
  readonly [field: string]: unknown;
}

/** The fields an AMENDED event may set (finding-event.schema.json `$defs/amended`). */
export interface AmendedFields {
  readonly owner_user?: string;
  readonly evidence?: string[];
  readonly notes?: string;
  readonly title?: string;
  readonly narrative?: string[];
}

/** Each event type's payload (MF-DESIGN §4.2). */
export interface FindingEventPayloads {
  readonly CREATED: CreatedPayload;
  readonly STATE_TRANSITIONED: {
    readonly from_state: FindingState;
    readonly to_state: GitStateTarget;
  };
  readonly CLOSURE_REJECTED: { readonly shas: readonly string[] };
  readonly OWNER_ASSIGNED: { readonly owner_user?: string; readonly deadline?: string };
  readonly AMENDED: { readonly fields: AmendedFields };
  readonly SUPERSEDED: { readonly successor_finding_id: string };
}

export type GitFindingEventType = keyof FindingEventPayloads;

/** The closed vocabulary, in the order finding-event.schema.json lists it. */
export const GIT_FINDING_EVENT_TYPES: readonly GitFindingEventType[] = [
  'CREATED',
  'STATE_TRANSITIONED',
  'CLOSURE_REJECTED',
  'OWNER_ASSIGNED',
  'AMENDED',
  'SUPERSEDED',
];

interface EventLineOf<T extends GitFindingEventType> {
  readonly event_id: string;
  readonly finding_id: string;
  readonly version: number;
  readonly event_type: T;
  readonly payload: FindingEventPayloads[T];
  readonly actor: string;
  readonly reason: T extends 'CREATED' ? null : string;
  readonly occurred_at: string;
  readonly prev_hash: string;
  readonly content_hash: string;
}

/** One line of a finding's event log. */
export type FindingEventLine = { [T in GitFindingEventType]: EventLineOf<T> }[GitFindingEventType];

type DraftOf<T extends GitFindingEventType> = Pick<
  EventLineOf<T>,
  'finding_id' | 'event_type' | 'payload' | 'actor' | 'reason' | 'occurred_at'
>;

/** What a writer decides; the store derives the version, the id and the chain. */
export type FindingEventDraft = { [T in GitFindingEventType]: DraftOf<T> }[GitFindingEventType];

/** A name-based (version 5 shaped) UUID: the same seed always gives the same id. */
function nameBasedUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed, 'utf8').digest().subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The hash a line carries: its canonical JSON without `content_hash`. */
export function eventContentHash(line: Omit<FindingEventLine, 'content_hash'>): string {
  return sha256hex(canonicalJson(line));
}

/**
 * The line `draft` becomes after `prior` (the finding's log so far), chained
 * on `anchor` when it is the first. The event id is a name-based UUID of the
 * position (finding, version, prev_hash), so a replay writes the same bytes.
 */
export function chainEvent(
  draft: FindingEventDraft,
  prior: readonly FindingEventLine[],
  anchor: string,
): FindingEventLine {
  const version = prior.length + 1;
  const prevHash = prior[prior.length - 1]?.content_hash ?? anchor;
  const body = {
    event_id: nameBasedUuid(`${draft.finding_id}:${version}:${prevHash}`),
    finding_id: draft.finding_id,
    version,
    event_type: draft.event_type,
    payload: draft.payload,
    actor: draft.actor,
    reason: draft.reason,
    occurred_at: draft.occurred_at,
    prev_hash: prevHash,
  } as Omit<FindingEventLine, 'content_hash'>;
  return { ...body, content_hash: eventContentHash(body) } as FindingEventLine;
}

/** One JSON object per line, newline-terminated: the bytes an append extends. */
export function serializeEventLines(lines: readonly FindingEventLine[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join('');
}

/** Where line 1 of `findingId`'s log chains: its genesis row, else the genesis tip. */
export function eventAnchor(genesis: readonly Finding[], findingId: string): string {
  return genesis.find((row) => row.id === findingId)?.content_hash ?? chainTip(genesis);
}

const eventValidators = new Map<string, ValidateFunction>();

/** The event line contract of `layout`, with the row contract its `$ref`s name. */
function eventValidator(layout: RegistryLayout): ValidateFunction {
  const cached = eventValidators.get(layout.eventSchemaPath);
  if (cached) return cached;
  const ajv = new Ajv2020({ allErrors: true, strict: false, verbose: true });
  addFormats(ajv);
  ajv.addSchema(JSON.parse(readFileSync(layout.rowSchemaPath, 'utf8')) as object);
  const validate = ajv.compile(JSON.parse(readFileSync(layout.eventSchemaPath, 'utf8')) as object);
  eventValidators.set(layout.eventSchemaPath, validate);
  return validate;
}

function schemaMessages(errors: readonly ErrorObject[] | null | undefined): string[] {
  return (errors ?? [])
    .filter((error) => error.keyword !== 'if')
    .map(
      (error) =>
        `${error.instancePath || '<root>'}: ${error.message ?? error.keyword} (got ${JSON.stringify(error.data)})`,
    );
}

/** Why `line` breaks the event line contract; empty when it holds. */
export function eventSchemaViolations(layout: RegistryLayout, line: unknown): string[] {
  const validate = eventValidator(layout);
  return validate(line) === true ? [] : schemaMessages(validate.errors);
}

/** The rows of `store` folded, keyed by id. */
function foldById(store: RegistryStore): Map<string, Finding> {
  return new Map(foldRegistry(store).map((row) => [row.id, row]));
}

/** The violations of a row an event wrote: the row contract and the owner rule. */
function writtenRowViolations(
  layout: RegistryLayout,
  before: ReadonlyMap<string, Finding>,
  row: Finding,
  born: boolean,
): string[] {
  const found = rowContractViolations(row, layout.rowSchemaPath, born ? 'always' : 'post-cutover');
  const previous = before.get(row.id);
  return [
    ...ownerViolations(previous === undefined ? [] : [previous], [row]),
    ...found.schema.map((message) => `${row.id} ${message}`),
    ...found.evidence.map(
      (item) => `${row.id} evidence[${item.index}]: ${JSON.stringify(item.evidence)}`,
    ),
  ];
}

/**
 * The lines `drafts` add to `store`, checked: every line is held to the event
 * schema, and every changed row (the fold of the store with the new lines) to
 * the row contract and the owner rule. A refusal throws
 * `RegistryWriteRefused`. Pure: the sink writes what it returns, and the
 * branch converter checks a conversion against the frozen segment before it
 * restores it.
 */
export function planFindingEvents(
  layout: RegistryLayout,
  store: RegistryStore,
  drafts: readonly FindingEventDraft[],
): Map<string, FindingEventLine[]> {
  const before = foldById(store);
  const appended = new Map<string, FindingEventLine[]>();
  const violations: string[] = [];
  for (const draft of drafts) {
    const exists = before.has(draft.finding_id) || appended.has(draft.finding_id);
    if (draft.event_type === 'CREATED' && exists) {
      violations.push(`${draft.finding_id}: already in the registry; CREATED starts a new finding`);
      continue;
    }
    if (draft.event_type !== 'CREATED' && !exists) {
      violations.push(`${draft.finding_id}: not in the registry`);
      continue;
    }
    const prior = [
      ...(store.logs.get(draft.finding_id)?.events ?? []),
      ...(appended.get(draft.finding_id) ?? []),
    ];
    const line = chainEvent(draft, prior, eventAnchor(store.genesis, draft.finding_id));
    for (const message of eventSchemaViolations(layout, line)) {
      violations.push(`${draft.finding_id} event ${line.version}: ${message}`);
    }
    appended.set(draft.finding_id, [...(appended.get(draft.finding_id) ?? []), line]);
  }
  if (violations.length > 0) throw new RegistryWriteRefused(violations);

  const candidate: RegistryStore = {
    genesis: store.genesis,
    logs: new Map(
      [...new Set([...store.logs.keys(), ...appended.keys()])].map((id) => {
        const path = eventLogRelativePath(id);
        const events = [...(store.logs.get(id)?.events ?? []), ...(appended.get(id) ?? [])];
        return [
          id,
          { path, findingId: id, bytes: Buffer.from(serializeEventLines(events)), events },
        ];
      }),
    ),
  };
  let after: Map<string, Finding>;
  try {
    after = foldById(candidate);
  } catch (error) {
    throw new RegistryWriteRefused([error instanceof Error ? error.message : String(error)]);
  }
  for (const id of appended.keys()) {
    const row = after.get(id);
    if (row === undefined) continue;
    violations.push(...writtenRowViolations(layout, before, row, !before.has(id)));
  }
  if (violations.length > 0) throw new RegistryWriteRefused(violations);
  return appended;
}

/**
 * The registry's one write: append `drafts`, in order, to their findings'
 * logs under `layout`, once `planFindingEvents` has accepted them; a refusal
 * throws `RegistryWriteRefused` and writes nothing. `beforeWrite` runs once
 * every check has passed and before the first byte is written (the allocator
 * records its id reservation there, so a crash never hands the id out
 * twice). Returns the store-relative paths it appended to.
 */
export function appendFindingEvents(
  layout: RegistryLayout,
  drafts: readonly FindingEventDraft[],
  lease: RegistryLockLease,
  beforeWrite?: () => void,
): string[] {
  const appended = planFindingEvents(layout, readRegistryStoreIn(layout.dir), drafts);
  beforeWrite?.();
  const written: string[] = [];
  for (const [id, lines] of appended) {
    const path = eventLogRelativePath(id);
    const file = join(layout.storeDir, path);
    mkdirSync(dirname(file), { recursive: true });
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    atomicWriteFileWithRegistryLease(file, `${existing}${serializeEventLines(lines)}`, lease);
    written.push(path);
  }
  return written;
}

/** genesis.json: the frozen segment's pin. */
export interface GenesisPin {
  readonly path: string;
  readonly blob_sha256: string;
  readonly entries: number;
  readonly tip_content_hash: string;
}

/** The pin of a genesis segment's bytes. */
export function genesisPin(blob: Buffer): GenesisPin {
  const rows = parseRegistryJsonl(blob.toString('utf8'));
  return {
    path: REGISTRY_RELATIVE_PATH,
    blob_sha256: createHash('sha256').update(blob).digest('hex'),
    entries: rows.length,
    tip_content_hash: chainTip(rows),
  };
}

/**
 * genesis.json's bytes: one field per line, two-space indent, as Prettier
 * formats a flat JSON object, so the file `genesis` writes is the file the
 * format gate accepts and the bytes the converter compares.
 */
export function serializeGenesisPin(pin: GenesisPin): string {
  const fields = Object.entries(pin).map(
    ([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`,
  );
  return `{\n${fields.join(',\n')}\n}\n`;
}

/**
 * What a change's base froze: the base the change is judged against and the
 * bytes of the genesis.json it holds. A base that predates the freeze holds
 * no genesis.json and has no `Freeze`: the cutover itself, and the landing of
 * a branch that merged origin/main before it, are the only times the segment
 * may still move.
 */
export interface Freeze {
  readonly base: string;
  readonly pin: Buffer;
}

/** The freeze `base` carries; null when `base` holds no genesis.json. An unknown `base` throws. */
export function freezeAt(repoRoot: string, base: string): Freeze | null {
  const listed = gitBytes(repoRoot, [
    'ls-tree',
    '--name-only',
    base,
    '--',
    GENESIS_PIN_RELATIVE_PATH,
  ])
    .toString('utf8')
    .trim();
  return listed === ''
    ? null
    : { base, pin: gitBytes(repoRoot, ['show', `${base}:${GENESIS_PIN_RELATIVE_PATH}`]) };
}

/**
 * The commit this checkout is judged against: the merge-base of HEAD and
 * origin/main, the base the always-run integrity spec holds the event logs and
 * the freeze to. Null when origin/main is not a ref of this repository (a
 * checkout that has not fetched main has no base to name).
 */
export function mergeBaseWithMain(repoRoot: string): string | null {
  const main = spawnSync(
    'git',
    ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', 'origin/main'],
    { env: repoPinnedEnv() },
  );
  if (main.error !== undefined) throw main.error;
  if (main.status !== 0) return null;
  return gitBytes(repoRoot, ['merge-base', 'HEAD', 'origin/main']).toString('utf8').trim();
}

/** The freeze of the base this checkout is judged against; null before the freeze lands. */
export function currentFreeze(repoRoot: string): Freeze | null {
  const base = mergeBaseWithMain(repoRoot);
  return base === null ? null : freezeAt(repoRoot, base);
}

/**
 * The three ways a segment and its pin come apart, and what to run for each.
 * Before the freeze (the base holds no genesis.json): a branch that still
 * wrote findings.jsonl converts its rows to events, and a landing that merged
 * origin/main re-pins. Once the base froze the segment, it is final: nothing
 * re-pins it, and the only way forward is to put the segment back and record
 * the change as events.
 */
export const GENESIS_REMEDY =
  'A branch that edited or appended findings.jsonl rows converts them to events with ' +
  '`ts-node --project tools/gates/tsconfig.json tools/gates/finding-registry-migrate-branch.ts ' +
  '--base=origin/main`; a landing that merged origin/main before the freeze re-pins the ' +
  'segment with `npm run findings:genesis`.';

/** The remedy once `freeze.base` froze the segment: no re-pin is offered, because none is allowed. */
export function frozenRemedy(freeze: Freeze): string {
  return (
    `${freeze.base} froze findings.jsonl and the freeze is final: a change to the segment is ` +
    `recorded as events. Convert the rows this branch wrote with ` +
    '`ts-node --project tools/gates/tsconfig.json tools/gates/finding-registry-migrate-branch.ts ' +
    '--base=origin/main`, which restores findings.jsonl and genesis.json to the base.'
  );
}

function readPin(layout: RegistryLayout): GenesisPin | null {
  return existsSync(layout.pinPath)
    ? (JSON.parse(readFileSync(layout.pinPath, 'utf8')) as GenesisPin)
    : null;
}

/**
 * Why the genesis segment of `snapshot` is not the one its pin names; empty
 * when it is. The remedy follows the base: `freeze` is the freeze the change's
 * base holds, and once there is one the message does not offer a re-pin.
 */
export function genesisPinDefects(snapshot: RegistrySnapshot, freeze: Freeze | null): string[] {
  const remedy = freeze === null ? GENESIS_REMEDY : frozenRemedy(freeze);
  const pin =
    snapshot.pinBytes === null
      ? null
      : (JSON.parse(snapshot.pinBytes.toString('utf8')) as GenesisPin);
  const actual = genesisPin(snapshot.genesisBlob);
  if (pin === null) return [`${GENESIS_PIN_RELATIVE_PATH} is missing. ${remedy}`];
  return (Object.keys(actual) as (keyof GenesisPin)[])
    .filter((key) => pin[key] !== actual[key])
    .map(
      (key) =>
        `findings.jsonl ${key} is ${JSON.stringify(actual[key])}, ${GENESIS_PIN_RELATIVE_PATH} ` +
        `pins ${JSON.stringify(pin[key])}. ${remedy}`,
    );
}

/**
 * Re-chain a log from a new anchor, keeping every decision: the lines'
 * contents stay, their position hashes and ids follow the anchor.
 */
function reanchor(events: readonly FindingEventLine[], anchor: string): FindingEventLine[] {
  const lines: FindingEventLine[] = [];
  for (const event of events) {
    const { event_id: _id, version: _v, prev_hash: _p, content_hash: _c, ...draft } = event;
    lines.push(chainEvent(draft, lines, anchor));
  }
  return lines;
}

/**
 * `finding-registry genesis` — pin the genesis segment as it stands in
 * `layout` (blob sha256, entry count, tip content_hash). The segment's chain
 * must verify first. Re-pinning is the landing step after a merge of
 * origin/main brought rows written before the freeze: the logs of findings
 * born on this branch were anchored on the previous tip, so they are
 * re-anchored on the new one (no decision changes). Once the freeze is on
 * main the segment never changes, so a rerun rewrites nothing. And once the
 * change's base holds the freeze (`freeze`), the pin it would write must be
 * the base's: a re-pin that moves a frozen segment is refused, so the command
 * is never the way around the freeze.
 */
export function pinGenesis(
  layout: RegistryLayout,
  lease: RegistryLockLease,
  freeze: Freeze | null,
): { pin: GenesisPin; reanchored: string[] } {
  const blob = readFileSync(layout.genesisPath);
  const rows = parseRegistryJsonl(blob.toString('utf8'));
  const chain = verify(rows);
  if (!chain.ok) {
    throw new RegistryWriteRefused([`findings.jsonl does not verify: ${chain.reason}`]);
  }
  const pin = genesisPin(blob);
  if (freeze !== null && !freeze.pin.equals(Buffer.from(serializeGenesisPin(pin), 'utf8'))) {
    throw new RegistryWriteRefused([
      `genesis refused: findings.jsonl is not the segment ${freeze.base} froze ` +
        `(${GENESIS_PIN_RELATIVE_PATH} there pins another blob), and re-pinning would move it. ` +
        frozenRemedy(freeze),
    ]);
  }
  const previous = readPin(layout);
  const reanchored: string[] = [];
  if (previous !== null && previous.tip_content_hash !== pin.tip_content_hash) {
    const genesisIds = new Set(rows.map((row) => row.id));
    for (const log of readRegistryStoreIn(layout.dir).logs.values()) {
      if (genesisIds.has(log.findingId)) continue;
      if (log.events[0]?.prev_hash !== previous.tip_content_hash) continue;
      atomicWriteFileWithRegistryLease(
        join(layout.storeDir, log.path),
        serializeEventLines(reanchor(log.events, pin.tip_content_hash)),
        lease,
      );
      reanchored.push(log.path);
    }
  }
  atomicWriteFileWithRegistryLease(layout.pinPath, serializeGenesisPin(pin), lease);
  return { pin, reanchored };
}

const EVENT_KEYS = [
  'actor',
  'content_hash',
  'event_id',
  'event_type',
  'finding_id',
  'occurred_at',
  'payload',
  'prev_hash',
  'reason',
  'version',
];

/** Why one log is not a valid chain anchored on `genesis`; empty when it is. */
function logDefects(
  layout: RegistryLayout,
  store: RegistryStore,
  path: string,
  bytes: Buffer,
  events: readonly FindingEventLine[],
  findingId: string,
): string[] {
  const defects: string[] = [];
  const where = (index: number): string => `${EVENT_STORE_RELATIVE_PATH}/${path}:${index + 1}`;
  const inGenesis = store.genesis.some((row) => row.id === findingId);
  if (events.length === 0) defects.push(`${EVENT_STORE_RELATIVE_PATH}/${path}: holds no event`);
  if (!bytes.toString('utf8').endsWith('\n')) {
    defects.push(`${EVENT_STORE_RELATIVE_PATH}/${path}: the last line is not newline-terminated`);
  }
  events.forEach((event, index) => {
    const keys = Object.keys(event).sort();
    if (canonicalJson(keys) !== canonicalJson(EVENT_KEYS)) {
      defects.push(`${where(index)}: fields ${keys.join(',')}`);
    }
    for (const message of eventSchemaViolations(layout, event)) {
      defects.push(`${where(index)}: ${message}`);
    }
    if (event.finding_id !== findingId)
      defects.push(`${where(index)}: finding_id ${event.finding_id}`);
    if (event.version !== index + 1) defects.push(`${where(index)}: version ${event.version}`);
    const created = event.event_type === 'CREATED';
    if (created !== (index === 0 && !inGenesis)) {
      defects.push(
        `${where(index)}: CREATED ${created ? 'where it may not stand' : 'missing'} ` +
          `(${inGenesis ? 'a genesis finding' : 'not in genesis'})`,
      );
    }
    const anchor =
      index === 0 ? eventAnchor(store.genesis, findingId) : events[index - 1]?.content_hash;
    if (event.prev_hash !== anchor) defects.push(`${where(index)}: prev_hash does not chain`);
    const { content_hash: stored, ...body } = event;
    if (stored !== eventContentHash(body)) {
      defects.push(`${where(index)}: content_hash does not match the line`);
    }
  });
  return defects;
}

/**
 * Why the registry `snapshot` holds is not intact; empty when it is: the
 * genesis segment's chain and pin, every log's chain and anchors, the
 * vocabulary, unique event ids, a fold that every reader can take, and the row
 * contract on every row an event wrote. The contracts are `layout`'s (the
 * schemas of the checkout that judges), the data is the snapshot's: the
 * working tree's, or a commit's (`verify --ref`). Without a pin the registry
 * has not been frozen: its segment's chain is all there is, and an event store
 * is refused (its lines would anchor on a segment nothing pins). A change whose
 * base holds the freeze (`freeze`) is refused without its pin too, and no
 * message offers a re-pin.
 */
export function registryDefects(
  layout: RegistryLayout,
  snapshot: RegistrySnapshot,
  freeze: Freeze | null,
): string[] {
  const { store } = snapshot;
  const defects: string[] = [];
  const chain = verify(store.genesis);
  if (!chain.ok) defects.push(`findings.jsonl: ${chain.reason}`);
  if (snapshot.pinBytes !== null || store.logs.size > 0 || freeze !== null) {
    defects.push(...genesisPinDefects(snapshot, freeze));
  }
  const eventIds = new Map<string, string>();
  for (const log of store.logs.values()) {
    defects.push(...logDefects(layout, store, log.path, log.bytes, log.events, log.findingId));
    for (const event of log.events) {
      const seen = eventIds.get(event.event_id);
      if (seen !== undefined) defects.push(`event_id ${event.event_id} in ${seen} and ${log.path}`);
      eventIds.set(event.event_id, log.path);
    }
  }
  if (defects.length > 0) return defects;
  let rows: Finding[];
  try {
    rows = foldRegistry(store);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const genesisIds = new Set(store.genesis.map((row) => row.id));
  for (const row of rows) {
    if (!store.logs.has(row.id)) continue;
    const found = rowContractViolations(
      row,
      layout.rowSchemaPath,
      genesisIds.has(row.id) ? 'post-cutover' : 'always',
    );
    defects.push(...found.schema.map((message) => `${row.id} ${message}`));
    defects.push(
      ...found.evidence.map(
        (item) => `${row.id} evidence[${item.index}]: ${JSON.stringify(item.evidence)}`,
      ),
    );
  }
  return defects;
}

function gitBytes(repoRoot: string, args: readonly string[]): Buffer {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    env: repoPinnedEnv(),
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * Why the working tree is not an append-only extension of `base`: every
 * event log `base` holds must still exist and start with its bytes at `base`,
 * and once `base` holds the freeze, genesis.json and the segment it pins must
 * be unchanged (the freeze is final).
 */
export function appendOnlyDefects(repoRoot: string, base: string): string[] {
  const logs = gitBytes(repoRoot, [
    'ls-tree',
    '-r',
    '-z',
    '--name-only',
    base,
    '--',
    `${EVENT_STORE_RELATIVE_PATH}/`,
  ])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const frozen =
    freezeAt(repoRoot, base) === null ? [] : [GENESIS_PIN_RELATIVE_PATH, REGISTRY_RELATIVE_PATH];
  const defects: string[] = [];
  for (const rel of [...logs, ...frozen]) {
    const now = join(repoRoot, rel);
    if (!existsSync(now)) {
      defects.push(`${rel}: deleted since ${base}`);
      continue;
    }
    const before = gitBytes(repoRoot, ['show', `${base}:${rel}`]);
    const here = readFileSync(now);
    if (frozen.includes(rel)) {
      if (!here.equals(before)) defects.push(`${rel}: changed since ${base} (the freeze is final)`);
    } else if (!here.subarray(0, before.length).equals(before)) {
      defects.push(`${rel}: rewritten since ${base} (only appends are allowed)`);
    }
  }
  return defects;
}
