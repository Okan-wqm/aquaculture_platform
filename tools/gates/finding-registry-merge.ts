/**
 * finding-registry-merge — the three-way merge of an append-only,
 * hash-chained ledger, as an algebra with no I/O.
 *
 * ## The problem this exists to remove
 *
 * `docs/reviews/_registry/findings.jsonl` is append-only: a branch records
 * its findings at the tail and never edits another branch's rows. Upstream,
 * the `automation/finding-closure-reconcile` lane marks findings RESOLVED
 * as their fixes merge — a legitimate mutation of PAST rows, which forces a
 * rechain of every row after the earliest closure.
 *
 * Those two facts make git's default text merge conflict on a file that has
 * no semantic conflict in it. A real case, 2026-09-11: upstream rewrote rows
 * 1066-1960 (six closures, then the rechain) while the branch appended
 * exactly one row, 1961. The correct result is not in question — upstream's
 * 1960 rows, then the branch's one, rechained — but the rewritten hunk ends
 * at the last line and the branch's append begins on the next one, so git
 * sees two adjacent edits and stops. Twenty stacked branches means the same
 * resolution twenty times, by hand, in the one file where a hand slip is
 * indistinguishable from tampering.
 *
 * `.gitattributes` already answers this shape twice — `merge=union` for
 * `docs/reviews/orphan-findings.md`, `merge=ours` for the derived ARIA
 * authority hash. Neither built-in fits here: `union` would keep BOTH the
 * pre-closure and post-closure copies of 895 rows, and `ours` would discard
 * upstream's closures. The ledger needs a driver that knows the invariant.
 *
 * ## What the merge is allowed to decide, and what it refuses
 *
 * It decides only what the append-only invariant makes unambiguous:
 *
 *   * the shared rows, matched BY ID and not by index — whichever side
 *     changed a row wins, because the other side did not touch it. Identity
 *     is the only stable key here: the moment an upstream row lands ahead of
 *     a branch's tail, every later index moves;
 *   * the order — the incoming side supplies it, and this branch's own rows
 *     are appended after. The result therefore extends the incoming side
 *     positionally, which is what keeps a CHAIN of merges monotonic: the next
 *     link up a stack takes this result as its incoming side and sees no
 *     reorder. The branch's rows stay the tail its `Closes:` trailers, plan
 *     snapshots and chain tip all name;
 *   * the chain — recomputed from the merged contents, which is why the
 *     result is verified rather than assumed.
 *
 * It REFUSES, and leaves a conflict for a human, on anything else:
 *
 *   * a row deleted on either side, or the base's rows reached out of their
 *     base order (not append-only). Order, not position: a base row that
 *     merely moved later because upstream appended ahead of it has not been
 *     reordered, and refusing that was this driver's own first bug;
 *   * the SAME row mutated differently on both sides (a genuine concurrent
 *     decision — e.g. one side closes a finding and the other reopens it;
 *     no merge rule can pick the true one);
 *   * an id absent from the merge base and present on BOTH sides — two
 *     branches minted the same finding id. That is the exact failure the
 *     allocator's reservation ledger exists to prevent, and it is refused
 *     even when the two rows read alike, because a merge is the last place
 *     to catch a duplicate allocation and the wrong place to settle one;
 *   * a result whose chain does not verify.
 *
 * A refusal is the point as much as a resolution is. The driver is a
 * Tier-2 "make the correct behaviour automatic" for the case that carries
 * no information, and it declines to be a Tier-4 "hope the operator
 * noticed" for the case that does.
 */

import {
  type Finding,
  parseRegistryJsonl,
  rechain,
  sameFindingBody,
  serializeRegistryJsonl,
  verify,
} from './finding-registry-chain';

export type RegistryMergeSide = 'ours' | 'theirs';

export interface RegistryMergeSuccess {
  readonly ok: true;
  readonly entries: Finding[];
  /** Rows taken from the side that changed them, per side, for the report. */
  readonly sharedRowsFrom: Readonly<Record<RegistryMergeSide, number>>;
  readonly addedFrom: Readonly<Record<RegistryMergeSide, number>>;
}

export interface RegistryMergeRefusal {
  readonly ok: false;
  readonly reason: string;
}

export type RegistryMergeResult = RegistryMergeSuccess | RegistryMergeRefusal;

function refuse(reason: string): RegistryMergeRefusal {
  return { ok: false, reason };
}

/**
 * Assert the append-only shape of one side against the merge base: every base
 * row is still there, and the base's rows appear in the side in the base's
 * relative order.
 *
 * This is the check that makes every later step safe. Without it, a side that
 * deleted or reordered a row would have its remaining rows paired against the
 * wrong base rows, and the merge would report a clean result for a ledger it
 * had quietly rewritten.
 *
 * The first version of this demanded a POSITIONAL prefix — `side[i].id ===
 * base[i].id` — and that was wrong in a way only a second merge reveals
 * (2026-09-16, cascading main up a 20-branch stack). Merge one: upstream's new
 * rows land ahead of the branch's own tail row, so the branch's row moves from
 * index 1960 to 1969 while keeping its position AFTER every base row. Merge
 * two, one link down, takes the pre-merge branch state as its base and sees
 * index 1960 disagree — and refused a merge in which nothing had been
 * reordered at all. Indices are not the invariant; ORDER is. A ledger where
 * two branches append and a merge interleaves the tails preserves every
 * side's relative order and no side's indices.
 */
function appendOnlyViolation(
  side: RegistryMergeSide,
  base: readonly Finding[],
  entries: readonly Finding[],
): string | null {
  const present = new Set(entries.map((entry) => entry.id));
  const missing = base.filter((entry) => !present.has(entry.id)).map((entry) => entry.id);
  if (missing.length > 0) {
    return (
      `${side} no longer carries ${missing.length === 1 ? 'row' : 'rows'} ` +
      `${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''} from the merge base: ` +
      'a row was deleted, which the append-only ledger does not permit'
    );
  }
  // Order-preserving subsequence: walk the side once, consuming base ids in
  // base order. A base row reached out of turn is a reorder.
  let cursor = 0;
  const baseIndexById = new Map(base.map((entry, index) => [entry.id, index]));
  for (const entry of entries) {
    const baseIndex = baseIndexById.get(entry.id);
    if (baseIndex === undefined) continue;
    if (baseIndex !== cursor) {
      return (
        `${side} reaches base row ${entry.id} (base index ${baseIndex}) where base index ` +
        `${cursor} (${String(base[cursor]?.id)}) was due: rows were reordered, which the ` +
        'append-only ledger does not permit'
      );
    }
    cursor += 1;
  }
  return null;
}

function duplicateId(entries: readonly Finding[]): string | null {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) return entry.id;
    seen.add(entry.id);
  }
  return null;
}

export function mergeAppendOnlyRegistry(
  base: readonly Finding[],
  ours: readonly Finding[],
  theirs: readonly Finding[],
): RegistryMergeResult {
  for (const [side, entries] of [
    ['ours', ours],
    ['theirs', theirs],
  ] as ReadonlyArray<readonly [RegistryMergeSide, readonly Finding[]]>) {
    const violation = appendOnlyViolation(side, base, entries);
    if (violation) return refuse(violation);
  }

  const baseById = new Map(base.map((entry) => [entry.id, entry]));
  const ourById = new Map(ours.map((entry) => [entry.id, entry]));
  const theirIds = new Set(theirs.map((entry) => entry.id));

  // THEIRS supplies the row ORDER; ours-only rows are appended after it.
  //
  // Two properties follow, and the cascade needs both. The result extends
  // `theirs` positionally, so a chain of merges up a stack stays monotonic —
  // the next link takes this result as its incoming side and the order check
  // passes without a reorder. And this branch's own rows stay the tail they
  // were authored as, which is what its `Closes:` trailers, plan snapshots
  // and chain tip all name.
  //
  // The rows are matched by ID, not by index. Indices move the moment an
  // upstream row lands ahead of a branch's tail; identity does not.
  const merged: Finding[] = [];
  const sharedRowsFrom: Record<RegistryMergeSide, number> = { ours: 0, theirs: 0 };
  let theirAdditions = 0;

  for (const theirEntry of theirs) {
    const baseEntry = baseById.get(theirEntry.id);
    if (!baseEntry) {
      // Not in the merge base, so it was added after the fork. If BOTH sides
      // carry it, both sides allocated it independently: two branches minted
      // the same finding id. That is the failure the allocator's reservation
      // ledger exists to prevent, and the one that once made eight commit
      // trailers resolve to the wrong finding — so it is refused even when
      // the two rows happen to read alike. A merge is the last place to catch
      // a duplicate allocation and the wrong place to settle one.
      if (ourById.has(theirEntry.id)) {
        return refuse(
          `duplicate finding id ${theirEntry.id} in the merged ledger — it is absent from the ` +
            'merge base and present on both sides, so two branches minted it; the allocation ' +
            'authority, not the merge, has to settle that',
        );
      }
      merged.push({ ...theirEntry });
      theirAdditions += 1;
      continue;
    }
    const ourEntry = ourById.get(theirEntry.id);
    if (!ourEntry) {
      return refuse(`${theirEntry.id} is missing from ours after the append-only check passed`);
    }
    const ourChanged = !sameFindingBody(ourEntry, baseEntry);
    const theirChanged = !sameFindingBody(theirEntry, baseEntry);

    if (ourChanged && theirChanged) {
      if (!sameFindingBody(ourEntry, theirEntry)) {
        return refuse(
          `${baseEntry.id} was changed differently on both sides — ` +
            'a concurrent decision on one finding, which no merge rule can resolve',
        );
      }
      merged.push({ ...theirEntry });
      sharedRowsFrom.theirs += 1;
      continue;
    }
    if (theirChanged) {
      merged.push({ ...theirEntry });
      sharedRowsFrom.theirs += 1;
      continue;
    }
    if (ourChanged) {
      merged.push({ ...ourEntry });
      sharedRowsFrom.ours += 1;
      continue;
    }
    merged.push({ ...baseEntry });
  }

  let ourAdditions = 0;
  for (const ourEntry of ours) {
    if (theirIds.has(ourEntry.id)) continue;
    merged.push({ ...ourEntry });
    ourAdditions += 1;
  }

  const duplicate = duplicateId(merged);
  if (duplicate) {
    return refuse(
      `duplicate finding id ${duplicate} in the merged ledger — two branches minted the ` +
        'same id; the allocation authority, not the merge, has to settle that',
    );
  }

  // The chain is a pure function of (contents, order), so rechaining from
  // zero rewrites nothing in an unchanged prefix and repairs exactly the
  // rows whose contents or position moved.
  rechain(merged, 0);

  const post = verify(merged);
  if (!post.ok) {
    return refuse(`merged ledger failed its own integrity check: ${String(post.reason)}`);
  }

  return {
    ok: true,
    entries: merged,
    sharedRowsFrom,
    addedFrom: { theirs: theirAdditions, ours: ourAdditions },
  };
}

/**
 * Text-in / text-out wrapper for the git merge driver. Parse failure is a
 * refusal, not a throw: a malformed side is exactly the case a human must
 * look at, and a driver that crashes tells git nothing useful.
 */
export function mergeRegistryText(
  baseRaw: string,
  oursRaw: string,
  theirsRaw: string,
): { ok: true; text: string; result: RegistryMergeSuccess } | RegistryMergeRefusal {
  let base: Finding[];
  let ours: Finding[];
  let theirs: Finding[];
  try {
    base = parseRegistryJsonl(baseRaw);
    ours = parseRegistryJsonl(oursRaw);
    theirs = parseRegistryJsonl(theirsRaw);
  } catch (error) {
    return refuse(
      `a side is not valid registry JSONL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = mergeAppendOnlyRegistry(base, ours, theirs);
  if (!result.ok) return result;
  return { ok: true, text: serializeRegistryJsonl(result.entries), result };
}
