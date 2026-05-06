import { ForbiddenException, Injectable } from '@nestjs/common';

import {
  __mintHoldClearedTokenForGuard,
  type HoldClearedToken,
} from '../../partition/partition-queries';
import {
  LegalHoldCheckUnavailable,
  LegalHoldService,
} from './legal-hold.service';

/**
 * Guard that turns a hold-registry check into a typed proof token
 * (LEGAL-MEDIUM-003 cure).
 *
 * # The destructive-helper choke-point
 *
 * `unsafeDropPartitionSql()` (in `partition/partition-queries.ts`) is
 * the architectural choke-point for all partition drops. Its argument
 * list demands a `HoldClearedToken` — a branded type whose factory
 * (`__mintHoldClearedTokenForGuard`) is import-restricted to THIS
 * module via the `tests/invariants/legal-hold-drop-partition-guard.spec.ts`
 * invariant. The token is therefore obtainable ONLY by calling
 * `assertHoldClearedFor()`, which:
 *
 *   1. Calls `LegalHoldService.isUnderLegalHold(tenantId, channelId)`.
 *   2. Throws `ForbiddenException` if a hold is active.
 *   3. Lets the fail-CLOSED `LegalHoldCheckUnavailable` exception
 *      from LEGAL-MEDIUM-001 propagate (registry-down → no token).
 *   4. Mints + returns a token only on the no-hold happy path.
 *
 * Combined with the brand, this means there is NO runtime path to
 * emit a partition-drop SQL string for a tenant under hold. The
 * agent-spec invariant is enforced at the type system level (Tier-1
 * "make impossible") rather than by a per-callsite review (Tier-4
 * documentation, the pre-cure state).
 */
@Injectable()
export class LegalHoldGuard {
  constructor(private readonly legalHoldService: LegalHoldService) {}

  /**
   * Consult the hold registry and return a `HoldClearedToken` if the
   * scope is clear of legal holds.
   *
   * @throws ForbiddenException if a hold is active for the scope.
   * @throws LegalHoldCheckUnavailable if the registry could not be
   *   consulted within the configured deadline (LEGAL-MEDIUM-001).
   */
  async assertHoldClearedFor(
    tenantId: string,
    channelId: string | null,
  ): Promise<HoldClearedToken> {
    let isHeld: boolean;
    try {
      isHeld = await this.legalHoldService.isUnderLegalHold(tenantId, channelId);
    } catch (err: unknown) {
      // Fail-CLOSED: a registry-unreachable error withholds the token,
      // which means the destructive helper cannot be called. Propagate
      // the typed error so callers can audit the failure mode.
      if (err instanceof LegalHoldCheckUnavailable) throw err;
      throw err;
    }

    if (isHeld) {
      throw new ForbiddenException(
        `Cannot proceed with destructive partition op: tenant=${tenantId} ` +
          `channel=${channelId ?? 'all'} is under an active legal hold`,
      );
    }
    return __mintHoldClearedTokenForGuard({ tenantId, channelId });
  }
}
