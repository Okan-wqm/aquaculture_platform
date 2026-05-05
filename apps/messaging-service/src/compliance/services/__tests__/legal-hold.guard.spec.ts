import { ForbiddenException } from '@nestjs/common';

import { LegalHoldGuard } from '../legal-hold.guard';
import {
  LegalHoldCheckUnavailable,
  type LegalHoldService,
} from '../legal-hold.service';
import { unsafeDropPartitionSql } from '../../../partition/partition-queries';

const TENANT = '00000000-0000-4000-8000-000000000001';
const CHANNEL = '00000000-0000-4000-8000-0000000000aa';

/**
 * LEGAL-MEDIUM-003 — guard behavior tests.
 *
 * The brand topology is pinned by the invariant
 * (tests/invariants/legal-hold-drop-partition-guard.spec.ts). These
 * specs pin the runtime guard contract:
 *   - happy path returns a token shaped for the destructive helper
 *   - hold-active path throws ForbiddenException
 *   - registry-down path propagates LegalHoldCheckUnavailable (fail-CLOSED)
 *   - the destructive helper accepts the minted token and returns SQL
 *   - the destructive helper rejects an obviously bogus token at runtime
 */
describe('LegalHoldGuard', () => {
  let legalHoldService: jest.Mocked<Pick<LegalHoldService, 'isUnderLegalHold'>>;
  let guard: LegalHoldGuard;

  beforeEach(() => {
    legalHoldService = {
      isUnderLegalHold: jest.fn(),
    };
    guard = new LegalHoldGuard(legalHoldService as unknown as LegalHoldService);
  });

  it('mints a token when the registry returns no-hold', async () => {
    legalHoldService.isUnderLegalHold.mockResolvedValue(false);

    const token = await guard.assertHoldClearedFor(TENANT, CHANNEL);

    expect(token.tenantId).toBe(TENANT);
    expect(token.channelId).toBe(CHANNEL);
    expect(token.checkedAt).toBeInstanceOf(Date);
  });

  it('throws ForbiddenException when the scope is under hold', async () => {
    legalHoldService.isUnderLegalHold.mockResolvedValue(true);

    await expect(
      guard.assertHoldClearedFor(TENANT, CHANNEL),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('propagates LegalHoldCheckUnavailable when registry is down (fail-CLOSED)', async () => {
    legalHoldService.isUnderLegalHold.mockRejectedValue(
      new LegalHoldCheckUnavailable('boom', TENANT, CHANNEL),
    );

    await expect(
      guard.assertHoldClearedFor(TENANT, CHANNEL),
    ).rejects.toBeInstanceOf(LegalHoldCheckUnavailable);
  });

  it('the minted token unlocks unsafeDropPartitionSql', async () => {
    legalHoldService.isUnderLegalHold.mockResolvedValue(false);

    const token = await guard.assertHoldClearedFor(TENANT, null);
    const sql = unsafeDropPartitionSql('messaging', 'messages', 2026, 1, token);

    expect(sql).toBe(
      `DROP TABLE IF EXISTS "messaging"."messages_2026_01";`,
    );
  });

  it('unsafeDropPartitionSql hard-rejects a bogus runtime token', () => {
    const bogus = { tenantId: '', channelId: null, checkedAt: new Date() } as Parameters<
      typeof unsafeDropPartitionSql
    >[4];
    expect(() => unsafeDropPartitionSql('messaging', 'messages', 2026, 1, bogus))
      .toThrow(/HoldClearedToken is required/);
  });
});
