/**
 * finding-registry-chain — the hash-chain algebra of the finding registry,
 * as one implementation with no I/O and no process state.
 *
 * `finding-registry.ts` owned private copies of `canonicalJson`, `rechain`
 * and `verify`. That was fine while the CLI was the only writer. It stopped
 * being fine the moment a SECOND writer needed the same algebra: the git
 * merge driver (`finding-registry-merge-driver.ts`) runs inside `git merge`,
 * long before any CLI subcommand, and a second transcription of a hash
 * chain is a second chance to disagree with the first — silently, in a
 * ledger whose whole value is that it cannot be edited unnoticed.
 *
 * So the algebra moved here and the CLI imports it. Two properties are
 * load-bearing and both are exercised by
 * `tests/invariants/finding-registry-merge-driver.spec.ts`:
 *
 *   1. The chain is a PURE FUNCTION of (entry contents, order).
 *      `content_hash = sha256(canonical(entry minus content_hash))`, and
 *      `prev_hash` is itself part of the hashed body, so the whole chain is
 *      determined by the rows and their order — nothing else. This is why
 *      `rechain(entries, 0)` is idempotent on an already-valid chain and
 *      why a merge may rechain from zero without rewriting a single hash it
 *      did not have to: an unchanged prefix hashes to the values it already
 *      carried.
 *
 *   2. `verify` is the only admission test. Anything that writes the
 *      registry runs it on the result and refuses on failure, rather than
 *      trusting that its own mutation was chain-safe.
 *
 * The independent re-implementation in
 * `tests/invariants/finding-registry-integrity.spec.ts` is deliberately NOT
 * consolidated here. A gate that imports the code it audits proves only
 * self-consistency; that spec exists to disagree with this file if this
 * file is wrong.
 */

import { createHash } from 'node:crypto';

export const ZERO_HASH = '0'.repeat(64);

export interface Finding {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  state: 'OPEN' | 'IN-PROGRESS' | 'RESOLVED' | 'STALE' | 'BLOCKED';
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
 * Key-sorted JSON without whitespace. Canonical form for hashing;
 * identical to the algorithm in tools/scripts/seed-finding-registry.mjs
 * and tests/invariants/finding-registry-integrity.spec.ts.
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
 * The identity of a finding ROW, excluding the chain pointers a rechain
 * owns. Two rows that differ only in `prev_hash`/`content_hash` carry the
 * same recorded fact; a merge must treat them as unchanged, or every
 * upstream rechain would read as a concurrent edit of every row after it.
 */
export function sameFindingBody(left: Finding, right: Finding): boolean {
  return findingBodyDigest(left) === findingBodyDigest(right);
}

export function findingBodyDigest(entry: Finding): string {
  // prev_hash and content_hash are the two fields `rechain` owns; the body
  // digest is everything else.
  const { prev_hash: _prevHash, content_hash: _contentHash, ...body } = entry;
  return canonicalJson(body);
}

/**
 * Recompute prev_hash + content_hash pointers from `startIndex` to the
 * end of `entries`. Mutation in place. Used by `close` after mutating
 * a past entry; every downstream entry carries a stale prev_hash until
 * rechained here.
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
