/**
 * FE dead-contract ratchet invariant
 * ============================================================================
 *
 * Every GraphQL operation const defined under web/** (an exported UPPER_SNAKE
 * `mutation|query|subscription` template) MUST be referenced by at least one
 * call site. A defined-but-unreferenced operation is a DEAD CONTRACT: it ships
 * to the bundle, reachable by nothing.
 *
 * Why this gate exists (Wave-6 M2, MSG-CRITICAL-001):
 *   `web/apps/aquamobil/src/graphql/messaging-operations.ts` exported
 *   `MARK_MESSAGES_READ`, and `useOfflineQueue` even carried a replay branch
 *   for it — but NO code ever invoked the mutation. `channel_members.lastReadAt`
 *   never advanced from mobile, so unread badges never cleared and senders
 *   never received read receipts. A core messaging guarantee was non-functional
 *   on the mobile surface, invisible because nothing type-checks "is this
 *   operation actually wired?". M3 (`ALL_MESSAGES_SINCE`) was the same shape.
 *
 * The wrong state (an operation document shipped with no call site) now fails
 * CI instead of failing silently in the user's app.
 *
 * Ratchet, not big-bang:
 *   ~108 dead contracts already existed across the four frontends when this
 *   gate was introduced (ORPHAN-MEDIUM-102). Fixing all of them in one change
 *   is neither safe nor reviewable, so they are FROZEN in
 *   `dead-contract-fe-operations.baseline.json`. This spec enforces a strict
 *   ratchet in BOTH directions:
 *     1. No NEW dead contract — a dead operation not in the baseline fails.
 *     2. The baseline stays honest — a baseline entry that has since been
 *        wired up or deleted fails, forcing the list to shrink. The baseline
 *        can therefore only get smaller; it can never be padded to silence
 *        the gate.
 *
 * The scan logic lives in `./lib/dead-contract-scan` and is shared with the
 * baseline generator so the two can never drift.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  scanDeadContracts,
  deadContractKey,
  type OperationConst,
  type OperationKind,
} from './lib/dead-contract-scan';

const REPO_ROOT = join(__dirname, '..', '..');
const BASELINE_PATH = join(
  __dirname,
  'dead-contract-fe-operations.baseline.json',
);

/**
 * ORPHAN-HIGH-507 — `kind` is the scanner's union, not a bare string.
 *
 * It was typed `string`, which made every `deadContractKey(entry)` call a type
 * error, and the tempting fixes were a cast at each call site or widening
 * `deadContractKey` to accept `string`. Both push the problem outward: the
 * baseline file is GENERATED from `OperationConst`s, so its `kind` values really
 * are the union — declaring `string` was the lie, not the mismatch.
 *
 * The type is therefore earned at the trust boundary instead of asserted: this
 * file is untrusted JSON on disk, so `loadBaseline` VALIDATES each entry and
 * fails loudly on anything else. A hand-edited baseline with `kind: "mutaton"`
 * now names itself at load time rather than silently failing to match a key and
 * quietly shrinking the ratchet.
 */
type BaselineEntry = Pick<OperationConst, 'id' | 'file' | 'kind'>;

const OPERATION_KINDS: readonly OperationKind[] = ['mutation', 'query', 'subscription'];

function isBaselineEntry(value: unknown): value is BaselineEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.file === 'string' &&
    typeof candidate.kind === 'string' &&
    (OPERATION_KINDS as readonly string[]).includes(candidate.kind)
  );
}

function loadBaseline(): BaselineEntry[] {
  const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as { entries?: unknown };
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  const invalid = entries.filter((entry) => !isBaselineEntry(entry));
  if (invalid.length > 0) {
    throw new Error(
      `dead-contract baseline has ${invalid.length} malformed entr(ies); ` +
        `each needs id, file and kind in ${OPERATION_KINDS.join('|')}: ` +
        JSON.stringify(invalid.slice(0, 3)),
    );
  }
  return entries.filter(isBaselineEntry);
}

describe('FE dead-contract ratchet invariant', () => {
  const dead = scanDeadContracts(REPO_ROOT);
  const baseline = loadBaseline();
  const baselineKeys = new Set(baseline.map((e) => deadContractKey(e)));
  const deadKeys = new Set(dead.map((d) => deadContractKey(d)));

  it('introduces no NEW dead contract (every defined FE GraphQL operation has ≥1 call site)', () => {
    const offenders = dead
      .filter((d) => !baselineKeys.has(deadContractKey(d)))
      .map((d) => `${d.kind} ${d.id}  (${d.file})`);

    if (offenders.length > 0) {
      throw new Error(
        `Dead GraphQL operation(s) defined but never referenced — wire a call ` +
          `site or delete the operation (do NOT add to the baseline):\n` +
          offenders.map((o) => `  - ${o}`).join('\n'),
      );
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the baseline honest — no entry that has been wired up or deleted', () => {
    // A baseline entry no longer in the live dead set means it was either
    // wired to a call site (good — burndown) or deleted (good). Either way it
    // must be removed from the baseline so the ratchet shrinks.
    const stale = baseline
      .filter((e) => !deadKeys.has(deadContractKey(e)))
      .map((e) => `${e.kind} ${e.id}  (${e.file})`);

    if (stale.length > 0) {
      throw new Error(
        `Baseline entr${stale.length === 1 ? 'y is' : 'ies are'} no longer a ` +
          `dead contract (wired up or deleted) — remove from ` +
          `dead-contract-fe-operations.baseline.json:\n` +
          stale.map((o) => `  - ${o}`).join('\n'),
      );
    }
    expect(stale).toEqual([]);
  });

  it('baseline count matches the recorded total', () => {
    expect(baseline.length).toBe(deadKeys.size);
  });
});
