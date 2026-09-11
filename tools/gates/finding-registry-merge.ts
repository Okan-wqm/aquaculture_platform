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
 *   * the shared prefix, row by row — whichever side changed a row wins,
 *     because the other side did not touch it;
 *   * the tail — upstream's new rows, then this branch's, so the branch's
 *     additions stay the tail they were authored as;
 *   * the chain — recomputed from the merged contents, which is why the
 *     result is verified rather than assumed.
 *
 * It REFUSES, and leaves a conflict for a human, on anything else:
 *
 *   * a row deleted or reordered on either side (not append-only);
 *   * the SAME row mutated differently on both sides (a genuine concurrent
 *     decision — e.g. one side closes a finding and the other reopens it;
 *     no merge rule can pick the true one);
 *   * a duplicate id between the two sides' additions (two branches minted
 *     the same finding id — the exact failure the allocator's reservation
 *     ledger exists to prevent, and not something a merge may paper over);
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
 * Assert the append-only shape of one side against the merge base: the
 * base's rows, in the base's order, are a prefix of the side's rows.
 *
 * This is the check that makes every later step safe. Without it, a side
 * that deleted or reordered a row would have its remaining rows silently
 * paired against the wrong base rows, and the merge would report a clean
 * result for a ledger it had quietly rewritten.
 */
function appendOnlyViolation(
  side: RegistryMergeSide,
  base: readonly Finding[],
  entries: readonly Finding[],
): string | null {
  if (entries.length < base.length) {
    return (
      `${side} has ${entries.length} rows but the merge base has ${base.length}: ` +
      'a row was deleted, which the append-only ledger does not permit'
    );
  }
  for (let i = 0; i < base.length; i++) {
    const baseId = base[i]?.id;
    const sideId = entries[i]?.id;
    if (baseId !== sideId) {
      return (
        `${side} row ${i} is ${String(sideId)} but the merge base has ${String(baseId)}: ` +
        'rows were reordered or removed, which the append-only ledger does not permit'
      );
    }
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

  const ourAdditions = ours.slice(base.length);
  const theirAdditions = theirs.slice(base.length);

  // Upstream's additions first, then this branch's: the branch authored its
  // rows as the tail and its `Closes:` trailers, plan snapshots and chain
  // tip all name that tail. Interleaving by timestamp would renumber it.
  const merged: Finding[] = [];
  const sharedRowsFrom: Record<RegistryMergeSide, number> = { ours: 0, theirs: 0 };

  for (let i = 0; i < base.length; i++) {
    const baseEntry = base[i];
    const ourEntry = ours[i];
    const theirEntry = theirs[i];
    if (!baseEntry || !ourEntry || !theirEntry) {
      return refuse(`row ${i} is missing on one side after the append-only check passed`);
    }
    const ourChanged = !sameFindingBody(ourEntry, baseEntry);
    const theirChanged = !sameFindingBody(theirEntry, baseEntry);

    if (ourChanged && theirChanged) {
      if (!sameFindingBody(ourEntry, theirEntry)) {
        return refuse(
          `${baseEntry.id} (row ${i}) was changed differently on both sides — ` +
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

  for (const entry of [...theirAdditions, ...ourAdditions]) merged.push({ ...entry });

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
    addedFrom: { theirs: theirAdditions.length, ours: ourAdditions.length },
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
