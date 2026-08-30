/**
 * StoredEventsCryptoShredHook — event-store's GDPR treatment for the immutable
 * stored_events log (crypto-shred rollout step 2).
 *
 * The hook is the bridge between the generic tenant-erasure executor and
 * TenantPayloadCryptoService.shred(): it must shred exactly the erased tenant's
 * key and propagate a shred failure so the erasure fails closed upstream.
 */
import { createBaseEvent, type TenantErasureRequestedEvent } from '@platform/event-contracts';

import { StoredEventsCryptoShredHook } from '../stored-events-crypto-shred.hook';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPERATION = '11111111-2222-4333-8444-555555555555';

function makeRequest(): TenantErasureRequestedEvent {
  return {
    ...createBaseEvent<TenantErasureRequestedEvent>('TenantErasureRequested', TENANT, {
      aggregateId: TENANT,
      aggregateType: 'Tenant',
    }),
    operationId: OPERATION,
    requestedBy: 'admin-user-1',
    requestedAt: '2026-07-12T00:00:00.000Z',
    legalHoldCheckedAt: '2026-07-12T00:00:00.000Z',
    dryRun: false,
    targetServiceCount: 12,
  };
}

function makeCrypto() {
  return { shred: jest.fn(() => Promise.resolve()) };
}

describe('StoredEventsCryptoShredHook', () => {
  it('shreds the erased tenant payload key', async () => {
    const crypto = makeCrypto();
    const hook = new StoredEventsCryptoShredHook(crypto as never);

    await hook.onTenantErased(makeRequest());

    expect(crypto.shred).toHaveBeenCalledTimes(1);
    expect(crypto.shred).toHaveBeenCalledWith(TENANT);
  });

  it('propagates a shred failure so the erasure fails closed upstream', async () => {
    const crypto = makeCrypto();
    crypto.shred.mockReturnValueOnce(Promise.reject(new Error('KEK unavailable')));
    const hook = new StoredEventsCryptoShredHook(crypto as never);

    await expect(hook.onTenantErased(makeRequest())).rejects.toThrow('KEK unavailable');
  });

  it('exposes a stable hookName (folded into the erasure proof hash)', () => {
    const hook = new StoredEventsCryptoShredHook(makeCrypto() as never);
    expect(hook.hookName).toBe('stored-events-crypto-shred');
  });
});
