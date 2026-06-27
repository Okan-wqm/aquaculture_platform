import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MockBillingProvider } from './mock-billing.provider';
import { StripeIdempotencyKey } from './stripe-api.types';

const idem = 'idem_test' as StripeIdempotencyKey;

/**
 * Contract for the BILLING_PROVIDER=mock client: it must RESOLVE every call with
 * benign local data (empty Stripe ids) and do ZERO outbound Stripe — so a
 * demo/test droplet (app.suderra.com) runs billing for real without a key, and a
 * later BILLING_PROVIDER=stripe flip never inherits a bogus synthetic id.
 */
describe('MockBillingProvider', () => {
  const provider = new MockBillingProvider();

  it('imports no Stripe SDK and performs no network I/O (source-level)', () => {
    const src = readFileSync(resolve(__dirname, 'mock-billing.provider.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"]stripe['"]/);
    expect(src).not.toMatch(/\bfetch\(|\bhttps?\.|\baxios\b|node:http/);
  });

  it('createSubscription resolves with an active local subscription + EMPTY Stripe id', async () => {
    const sub = await provider.createSubscription({
      customerId: 'cus_x',
      priceId: 'price_x',
      metadata: { tenantId: 't1' },
      idempotencyKey: idem,
    });
    expect(sub).toMatchObject({ id: '', customer: '', status: 'active' });
    expect(typeof sub.currentPeriodStartIso).toBe('string');
    expect(typeof sub.currentPeriodEndIso).toBe('string');
  });

  it('createCustomer + createRefund resolve with empty ids (no Stripe object)', async () => {
    const cust = await provider.createCustomer({
      email: 'a@b.test',
      metadata: {},
      idempotencyKey: idem,
    });
    expect(cust.id).toBe('');
    const refund = await provider.createRefund({
      chargeId: 'ch_1',
      amount: 100n,
      reason: 'requested_by_customer',
      idempotencyKey: idem,
    });
    expect(refund).toMatchObject({ id: '', status: 'succeeded', chargeId: 'ch_1' });
  });

  it('cancelSubscription marks canceled; finalizeInvoice + reportMeterEvent resolve', async () => {
    const canceled = await provider.cancelSubscription({
      subscriptionId: 'sub_1',
      immediately: true,
      idempotencyKey: idem,
    });
    expect(canceled).toMatchObject({ id: 'sub_1', status: 'canceled' });

    await expect(
      provider.finalizeInvoice({ invoiceId: 'in_1', idempotencyKey: idem }),
    ).resolves.toMatchObject({ id: '', status: 'open' });

    await expect(
      provider.reportMeterEvent({
        identifier: 'evt_1',
        meterEventName: 'api_calls',
        customerId: 'cus_x',
        value: 5n,
        idempotencyKey: idem,
      }),
    ).resolves.toBeUndefined();
  });
});
