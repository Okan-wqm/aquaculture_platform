import { ConfigService } from '@nestjs/config';

import { IStripeApiClient, StripeIdempotencyKey } from './stripe-api.types';
import {
  BILLING_PROVIDER_ENV,
  STRIPE_BILLING_ENABLED_ENV,
  STRIPE_SECRET_KEY_ENV,
  StripeNotConfiguredError,
  stripeClientFactory,
} from './stripe-client.factory';
import { MockBillingProvider } from './mock-billing.provider';

/**
 * Boot + request-time contract for the flag-gated Stripe client factory.
 *
 * The SSoT flag STRIPE_BILLING_ENABLED reconciles graceful-boot with
 * fail-closed (#640): off (any env, incl. production) boots with a disabled
 * client that rejects at request time; on+key returns the real client; on+no-key
 * refuses to boot.
 *
 * ConfigService stub: a structurally-correct Partial<ConfigService> exposing
 * only the `get(key, default?)` overload the factory uses, narrowed once with a
 * single `as ConfigService` cast (the repo bans broad/double casts). The narrow
 * `get` signature matches the @nestjs/config default-value overload.
 */
function configStub(values: Record<string, string | undefined>): ConfigService {
  const partial: Partial<ConfigService> = {
    get: ((key: string, defaultValue?: string): string | undefined => {
      const value = values[key];
      return value === undefined ? defaultValue : value;
    }) as ConfigService['get'],
  };
  return partial as ConfigService;
}

const requestArgs = {
  metadata: {},
  idempotencyKey: 'idem_test' as StripeIdempotencyKey,
};

describe('stripeClientFactory (STRIPE_BILLING_ENABLED SSoT)', () => {
  it('(a) flag unset/false in production → boots without throwing, returns a client', () => {
    const config = configStub({ NODE_ENV: 'production' });

    let client: IStripeApiClient | undefined;
    expect(() => {
      client = stripeClientFactory(config);
    }).not.toThrow();
    expect(client).toBeDefined();
  });

  it('(b) disabled client fails closed with StripeNotConfiguredError when any mutation is attempted at request time', () => {
    const config = configStub({ NODE_ENV: 'production' });
    const client = stripeClientFactory(config);

    // The disabled sentinel fails closed the instant a Stripe call is made
    // (synchronous throw before any await), so no outbound traffic can leak.
    expect(() =>
      client.createCustomer({ email: 'a@b.test', ...requestArgs }),
    ).toThrow(StripeNotConfiguredError);
    expect(() =>
      client.createSubscription({
        customerId: 'cus_1',
        priceId: 'price_1',
        ...requestArgs,
      }),
    ).toThrow(StripeNotConfiguredError);
  });

  it('(c) enabled + no key → throws at boot, mentioning STRIPE_SECRET_KEY', () => {
    const config = configStub({
      [STRIPE_BILLING_ENABLED_ENV]: 'true',
      NODE_ENV: 'production',
    });

    expect(() => stripeClientFactory(config)).toThrow(
      new RegExp(STRIPE_SECRET_KEY_ENV),
    );
  });

  it('(d) enabled + sk_test key → returns the real client (no throw)', () => {
    const config = configStub({
      [STRIPE_BILLING_ENABLED_ENV]: 'true',
      [STRIPE_SECRET_KEY_ENV]: 'sk_test_abc123',
      NODE_ENV: 'development',
    });

    let client: IStripeApiClient | undefined;
    expect(() => {
      client = stripeClientFactory(config);
    }).not.toThrow();
    expect(client).toBeDefined();
    // The real adapter does NOT throw the disabled-client sentinel synchronously;
    // it would attempt a live Stripe call (not exercised here).
    expect(client).not.toBeInstanceOf(StripeNotConfiguredError);
  });

  it('(e) enabled + sk_live key outside production → throws at boot', () => {
    const config = configStub({
      [STRIPE_BILLING_ENABLED_ENV]: 'true',
      [STRIPE_SECRET_KEY_ENV]: 'sk_live_realkey',
      NODE_ENV: 'development',
    });

    expect(() => stripeClientFactory(config)).toThrow(/sk_live_/);
  });

  it('(f) BILLING_PROVIDER=mock → a functional MockBillingProvider (no key, calls RESOLVE)', async () => {
    const config = configStub({
      [BILLING_PROVIDER_ENV]: 'mock',
      NODE_ENV: 'production',
    });

    const client = stripeClientFactory(config);
    expect(client).toBeInstanceOf(MockBillingProvider);
    // Unlike the disabled client (which throws), mock calls RESOLVE with local
    // data carrying an empty Stripe id — so a demo tenant's billing actually works.
    await expect(
      client.createSubscription({ customerId: 'cus_1', priceId: 'price_1', ...requestArgs }),
    ).resolves.toMatchObject({ id: '', status: 'active' });
  });

  it('(g) BILLING_PROVIDER=mock wins with no key + STRIPE_BILLING_ENABLED unset (case-insensitive)', () => {
    const config = configStub({ [BILLING_PROVIDER_ENV]: 'MOCK', NODE_ENV: 'production' });
    expect(() => stripeClientFactory(config)).not.toThrow();
    expect(stripeClientFactory(config)).toBeInstanceOf(MockBillingProvider);
  });

  it('(h) BILLING_PROVIDER=stripe implies enabled → missing key throws at boot', () => {
    const config = configStub({ [BILLING_PROVIDER_ENV]: 'stripe', NODE_ENV: 'production' });
    expect(() => stripeClientFactory(config)).toThrow(new RegExp(STRIPE_SECRET_KEY_ENV));
  });
});
