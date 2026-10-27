/**
 * The per-finding event store as MF-2 lays it out on disk (MF-DESIGN §4.1–§4.3),
 * written by tests that replay git merges of it.
 *
 * WHY. Two PRs that add different findings must touch different paths, and
 * two PRs that change the same finding must append to the same file. Those
 * are properties of the bytes git merges, so the merge replays
 * (derived-merge-pins.spec.ts) write the event lines themselves, in the
 * format the design fixes, and then read the result through the real
 * projection. A writer that produced a different layout would not be read
 * back, and the replay would say so.
 *
 * WHAT. One file per finding, `docs/reviews/_registry/findings/<PREFIX>/<ID>.jsonl`
 * (PREFIX is the id's leading segment, e.g. `ARIA` for `ARIA-HIGH-012`), one
 * event per line with exactly the fields
 * `{event_id, finding_id, version, event_type, payload, actor, reason,
 * occurred_at, prev_hash, content_hash}`:
 *
 *   - `version` is the 1-based line number;
 *   - `event_id` is a UUID, deterministic here so a replay is reproducible
 *     (the Postgres mirror stores the git event verbatim, and its column is a UUID);
 *   - `reason` is null on CREATED and a non-empty string on every other event;
 *   - line 1's `prev_hash` is the finding's genesis row `content_hash` when the
 *     id is in the frozen findings.jsonl, else the genesis tip; line n's is
 *     line n−1's `content_hash`;
 *   - `content_hash = sha256(canonicalJson(event − content_hash))`, with the
 *     one canonicalJson of finding-registry-chain.ts.
 *
 * A CREATED payload is the full row body minus the chain fields (`id` included).
 */
import { createHash } from 'node:crypto';

import {
  canonicalJson,
  type Finding,
  type FindingState,
  sha256hex,
} from '../../../tools/gates/finding-registry-chain';

export const EVENT_STORE_RELATIVE_DIR = 'docs/reviews/_registry/findings';
export const GENESIS_RELATIVE_PATH = 'docs/reviews/_registry/genesis.json';
export const EVENT_SCHEMA_RELATIVE_PATH = 'docs/reviews/_registry/finding-event.schema.json';

/** The closed vocabulary (MF-DESIGN §4.2). RESOLVED is reachable by none of them. */
export const GIT_FINDING_EVENT_TYPES = [
  'CREATED',
  'STATE_TRANSITIONED',
  'CLOSURE_REJECTED',
  'OWNER_ASSIGNED',
  'AMENDED',
  'SUPERSEDED',
] as const;
export type GitFindingEventType = (typeof GIT_FINDING_EVENT_TYPES)[number];

/** The ten fields of one event line, in the order a writer emits them. */
export const EVENT_FIELDS = [
  'event_id',
  'finding_id',
  'version',
  'event_type',
  'payload',
  'actor',
  'reason',
  'occurred_at',
  'prev_hash',
  'content_hash',
] as const;

export interface FindingEventLine {
  readonly event_id: string;
  readonly finding_id: string;
  readonly version: number;
  readonly event_type: GitFindingEventType;
  readonly payload: Record<string, unknown>;
  readonly actor: string;
  readonly reason: string | null;
  readonly occurred_at: string;
  readonly prev_hash: string;
  readonly content_hash: string;
}

/** What a writer decides; the store derives the rest. */
export interface EventDraft {
  readonly event_type: GitFindingEventType;
  readonly payload: Record<string, unknown>;
  readonly actor?: string;
  readonly reason: string | null;
  readonly occurred_at: string;
}

export const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The repository-relative path of a finding's event log. */
export function eventFilePath(findingId: string): string {
  const [prefix] = findingId.split('-');
  return `${EVENT_STORE_RELATIVE_DIR}/${prefix}/${findingId}.jsonl`;
}

/** A name-based (version 5 shaped) UUID: the same seed always gives the same id. */
function deterministicUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed, 'utf8').digest().subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The hash a line carries: its canonical JSON without `content_hash`. */
export function eventContentHash(event: Omit<FindingEventLine, 'content_hash'>): string {
  return sha256hex(canonicalJson(event));
}

/**
 * The next event of `findingId`'s log: `prior` is the log so far, `anchor`
 * the hash line 1 chains to (the genesis row's content_hash or the genesis tip).
 */
export function nextEvent(
  findingId: string,
  prior: readonly FindingEventLine[],
  anchor: string,
  draft: EventDraft,
): FindingEventLine {
  const version = prior.length + 1;
  const prevHash = prior[prior.length - 1]?.content_hash ?? anchor;
  const body: Omit<FindingEventLine, 'content_hash'> = {
    event_id: deterministicUuid(`${findingId}:${version}:${prevHash}`),
    finding_id: findingId,
    version,
    event_type: draft.event_type,
    payload: draft.payload,
    actor: draft.actor ?? 'Okan-wqm',
    reason: draft.reason,
    occurred_at: draft.occurred_at,
    prev_hash: prevHash,
  };
  return { ...body, content_hash: eventContentHash(body) };
}

/** One JSON object per line, newline-terminated: the bytes an append extends. */
export function serializeEvents(events: readonly FindingEventLine[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join('');
}

export function parseEvents(text: string): FindingEventLine[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as FindingEventLine);
}

/** A CREATED payload: the row body without the chain fields. */
export function createdPayload(row: Finding): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== 'prev_hash' && key !== 'content_hash'),
  );
}

/** A STATE_TRANSITIONED payload; the type keeps RESOLVED out of `to`. */
export function transition(
  from: FindingState,
  to: Exclude<FindingState, 'RESOLVED'>,
): Record<string, unknown> {
  return { from_state: from, to_state: to };
}
