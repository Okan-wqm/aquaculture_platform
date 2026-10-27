/**
 * finding-registry assign — the governed write of a finding's accountability
 * fields (`owner_user`, `deadline`) onto a row that lacks them.
 *
 * WHY (ARIA-HIGH-044). An unresolved CRITICAL with no deadline is out of reach
 * of every governance timer: `planSweep` exempts CRITICALs from staleness and
 * its past-deadline BLOCKED branch never fires without a deadline. The row
 * contract now refuses such a row at every write (findings.jsonl.schema.json
 * `$defs/accountable`, applied by finding-registry-rows.ts), so a row
 * registered before the rule needs a sanctioned way to gain the fields. Before
 * this verb the only way was a hand edit of a hash-chained ledger.
 *
 * WHAT IT MAY DO. Fill, never change: each field goes from missing (null,
 * absent or blank) to a value; the same value again is a no-op; a different
 * value is refused, because re-dating a deadline or handing a finding to
 * someone else is an override decision with its own ceremony, not an
 * assignment. A reason is required and recorded in `notes`. A deadline the
 * sweep would already call lapsed is refused: writing one is a
 * mis-registration, not a commitment. Any state is accepted, RESOLVED
 * included, so a reopen of an ownerless RESOLVED CRITICAL has a path.
 *
 * WHO MAY OWN (ARIA-MEDIUM-535). The owner is stored as its .github/CODEOWNERS
 * handle (`canonicalOwner`): `@okan-wqm` is written `Okan-wqm`, and a value no
 * handle names is refused.
 */

import { type Finding, isDeadlineLapsed } from './finding-registry-chain';
import { canonicalOwner } from './finding-registry-owners';

export interface AssignmentRequest {
  readonly ownerUser?: string;
  readonly deadline?: string;
  readonly reason: string;
  readonly now: Date;
}

/** The two fields an assignment fills. */
export type AccountabilityField = 'owner_user' | 'deadline';

export type AssignmentOutcome =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly fields: readonly AccountabilityField[];
    }
  | { readonly ok: false; readonly reason: string };

function present(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Applies the assignment to `entry` in place, or refuses without touching it.
 * The caller records the filled `fields` as an OWNER_ASSIGNED event; the write
 * sink then holds the resulting row to the full row contract.
 */
export function applyAssignment(entry: Finding, request: AssignmentRequest): AssignmentOutcome {
  if (request.ownerUser === undefined && request.deadline === undefined) {
    return { ok: false, reason: 'assign needs --owner-user=<handle>, --deadline=<date> or both' };
  }
  const reason = request.reason.trim();
  if (reason === '') {
    return { ok: false, reason: 'assign requires --reason=<why this owner and date>' };
  }

  let ownerUser: string | undefined;
  if (request.ownerUser !== undefined) {
    const resolved = canonicalOwner(request.ownerUser);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    ownerUser = resolved.owner;
  }
  const requested: [AccountabilityField, string | undefined][] = [
    ['owner_user', ownerUser],
    ['deadline', request.deadline],
  ];
  const writes: [AccountabilityField, string][] = [];
  for (const [field, value] of requested) {
    if (value === undefined) continue;
    const current = entry[field];
    if (current === value) continue;
    if (present(current)) {
      return {
        ok: false,
        reason:
          `${entry.id} ${field} is already ${JSON.stringify(current)}; assign fills a missing ` +
          'value and never changes one (re-dating or re-owning a finding is an override decision)',
      };
    }
    writes.push([field, value]);
  }

  const deadline = writes.find(([field]) => field === 'deadline')?.[1];
  if (deadline !== undefined) {
    if (Number.isNaN(new Date(deadline).getTime())) {
      return { ok: false, reason: `deadline ${JSON.stringify(deadline)} is not a date` };
    }
    if (isDeadlineLapsed(deadline, request.now)) {
      return {
        ok: false,
        reason: `deadline ${deadline} has already lapsed by the sweep's clock (now ${request.now.toISOString()})`,
      };
    }
  }

  if (writes.length === 0) return { ok: true, changed: false, fields: [] };

  for (const [field, value] of writes) entry[field] = value;
  const stamp = request.now.toISOString().slice(0, 10);
  const assigned = writes.map(([field, value]) => `${field}=${value}`).join(', ');
  entry.notes = String(entry.notes ?? '') + ` [assign ${stamp}: ${assigned} — ${reason}]`;
  return { ok: true, changed: true, fields: writes.map(([field]) => field) };
}
