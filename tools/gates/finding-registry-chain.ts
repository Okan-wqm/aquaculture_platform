/**
 * finding-registry-chain — the hash-chain algebra of the finding registry,
 * as one implementation with no I/O and no process state.
 *
 * `finding-registry.ts` owned private copies of `canonicalJson`, `rechain`
 * and `verify`. A second transcription of a hash chain is a second chance to
 * disagree with the first — silently, in a ledger whose whole value is that
 * it cannot be edited unnoticed — so the algebra lives here, once, and every
 * reader and writer imports it: the genesis segment's chain (findings.jsonl,
 * frozen since MF-2) and the per-finding event chains
 * (finding-registry-events.ts) hash with the same `canonicalJson`.
 *
 * Two properties are load-bearing:
 *
 *   1. The chain is a PURE FUNCTION of (entry contents, order).
 *      `content_hash = sha256(canonical(entry minus content_hash))`, and
 *      `prev_hash` is itself part of the hashed body, so the whole chain is
 *      determined by the rows and their order — nothing else. This is why
 *      `rechain(entries, 0)` is idempotent on an already-valid chain: an
 *      unchanged prefix hashes to the values it already carried.
 *
 *   2. `verify` is the only admission test of the genesis segment: the
 *      registry verifier (`finding-registry verify`) runs it, and the pin
 *      (genesis.json) records the tip it reaches.
 *
 * The independent re-implementation in
 * `tests/invariants/finding-registry-integrity.spec.ts` is deliberately NOT
 * consolidated here. A gate that imports the code it audits proves only
 * self-consistency; that spec exists to disagree with this file if this
 * file is wrong.
 */

import { createHash } from 'node:crypto';

export const ZERO_HASH = '0'.repeat(64);

/** The registry's lifecycle vocabulary (findings.jsonl.schema.json `state`). */
export const FINDING_STATES = ['OPEN', 'IN-PROGRESS', 'RESOLVED', 'STALE', 'BLOCKED'] as const;
export type FindingState = (typeof FINDING_STATES)[number];

/**
 * The states that still carry the debt: everything but RESOLVED.
 *
 * WHY ONE PREDICATE (ARIA-HIGH-534). BLOCKED and STALE are judgements about a
 * finding, not resolutions of it — the daily sweep moves a past-deadline row
 * to BLOCKED precisely because it is still open past its date. A reader that
 * kept its own "active = OPEN or IN-PROGRESS" list (debt-plan-truth did)
 * reads that sweep as the CRITICAL leaving the debt with no closing commit and
 * refuses the sweep PR, so no deadline transition ever lands. Every reader
 * that asks "is this finding still owed?" asks this function.
 */
export const UNRESOLVED_FINDING_STATES: readonly FindingState[] = FINDING_STATES.filter(
  (state) => state !== 'RESOLVED',
);

export function isUnresolvedFindingState(state: string): boolean {
  return (UNRESOLVED_FINDING_STATES as readonly string[]).includes(state);
}

/**
 * The sweep's clock: a deadline has lapsed once `new Date(deadline)` is
 * before `now`, so a calendar date lapses at the start of its UTC day. An
 * unparseable deadline never lapses here (the schema's `format` refuses it at
 * every write). `planSweep` blocks on it and `assign` refuses to write a
 * deadline it would already call lapsed (ARIA-HIGH-044), so the two cannot
 * disagree by a day.
 */
export function isDeadlineLapsed(deadline: string, now: Date): boolean {
  const due = new Date(deadline).getTime();
  return !Number.isNaN(due) && due < now.getTime();
}

/**
 * Whether a row names someone accountable: a non-blank `owner_user`, the
 * property the schema's `$defs/accountable` requires of every BLOCKED row and
 * every unresolved CRITICAL. The sweep asks it before it blocks a lapsed row,
 * so it never plans a BLOCKED row no owner can sign an override for
 * (ARIA-MEDIUM-601).
 */
export function hasAccountableOwner(entry: Pick<Finding, 'owner_user'>): boolean {
  return typeof entry.owner_user === 'string' && entry.owner_user.trim() !== '';
}

export interface Finding {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  state: FindingState;
  title: string;
  layer?: number;
  evidence?: string[];
  rule_violated?: string;
  owner_agent: string;
  raised_in_cycle: string;
  review_file?: string;
  created_at: string;
  closed_at: string | null;
  closing_commits: string[];
  /** Closers an override reopen rejected; see `closureAdmissible`. */
  rejected_closing_commits?: string[];
  deadline: string | null;
  owner_user: string | null;
  override_of: string | null;
  notes?: string;
  prev_hash: string;
  content_hash: string;
  [key: string]: unknown;
}

export function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Key-sorted JSON without whitespace. Canonical form for hashing; identical
 * to the independent algorithm in tests/invariants/finding-registry-integrity.spec.ts.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

/** The registry's on-disk form: one JSON object per line, trailing newline. */
export function serializeRegistryJsonl(entries: readonly Finding[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}

export function parseRegistryJsonl(raw: string): Finding[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  return trimmed
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Finding);
}

/**
 * Recompute prev_hash + content_hash pointers from `startIndex` to the
 * end of `entries`. Mutation in place. No registry writer calls it since
 * the genesis segment froze (MF-2); fixtures build a chain-valid segment
 * with it.
 */
export function rechain(entries: Finding[], startIndex: number): void {
  let prev = startIndex === 0 ? ZERO_HASH : (entries[startIndex - 1]?.content_hash ?? ZERO_HASH);
  for (let i = startIndex; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    entry.prev_hash = prev;
    // content_hash = sha256(canonical JSON of entry minus content_hash)
    const { content_hash: _, ...forHash } = entry;
    const hash = sha256hex(canonicalJson(forHash));
    entry.content_hash = hash;
    prev = hash;
  }
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  firstFailureIndex: number | null;
  reason: string | null;
}

export function verify(entries: readonly Finding[]): VerifyResult {
  let prev = ZERO_HASH;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.prev_hash !== prev) {
      return {
        ok: false,
        entries: entries.length,
        firstFailureIndex: i,
        reason: `chain break at entry ${i} (${entry.id}): prev_hash=${entry.prev_hash} expected=${prev}`,
      };
    }
    const { content_hash, ...forHash } = entry;
    const recomp = sha256hex(canonicalJson(forHash));
    if (recomp !== content_hash) {
      return {
        ok: false,
        entries: entries.length,
        firstFailureIndex: i,
        reason: `hash mismatch at entry ${i} (${entry.id}): recomputed=${recomp} stored=${content_hash}`,
      };
    }
    prev = content_hash;
  }
  return { ok: true, entries: entries.length, firstFailureIndex: null, reason: null };
}

export function chainTip(entries: readonly Finding[]): string {
  if (entries.length === 0) return ZERO_HASH;
  return entries[entries.length - 1]?.content_hash ?? ZERO_HASH;
}
