import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  ConfigRuntimeClient,
  BillingStripeSettings,
} from '../../config-client/config-runtime.client';
import type { SecurityEventService } from '../../security/security-event.service';
import { DynamicStripeClientProvider } from '../dynamic-stripe-client.provider';
import { MockBillingProvider } from '../mock-billing.provider';
import type { IStripeApiClient, StripeIdempotencyKey } from '../stripe-api.types';
import { UnconfiguredStripeClient, StripeNotConfiguredError } from '../stripe-client.factory';

/**
 * DynamicStripeClientProvider — the 7-row config>env>mock precedence table, the
 * invalidation contract, the secret-never-logged invariant, and the
 * boot-never-crashes-on-enabled-keyless outage cure (ORPHAN-397).
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

function runtimeStub(settings: BillingStripeSettings | (() => Promise<BillingStripeSettings>)): {
  client: ConfigRuntimeClient;
  spy: jest.Mock;
} {
  const spy = jest.fn(() =>
    typeof settings === 'function' ? settings() : Promise.resolve(settings),
  );
  const client: Partial<ConfigRuntimeClient> = { getBillingStripeSettings: spy };
  return { client: client as ConfigRuntimeClient, spy };
}

function securityStub(): { svc: SecurityEventService; publish: jest.Mock } {
  const publish = jest.fn(() => Promise.resolve(undefined));
  const svc: Partial<SecurityEventService> = { publishSuspiciousActivity: publish };
  return { svc: svc as SecurityEventService, publish };
}

const args = { metadata: {}, idempotencyKey: 'idem' as StripeIdempotencyKey };

// UnconfiguredStripeClient throws SYNCHRONOUSLY the instant a call is made
// (fail-closed before any await), so no outbound traffic can leak.
function expectFailsClosed(client: IStripeApiClient): void {
  expect(() => client.createCustomer({ email: 'a@b.test', ...args })).toThrow(
    StripeNotConfiguredError,
  );
}

describe('DynamicStripeClientProvider — precedence (config > env > mock)', () => {
  it('(1) config enabled + secret present → Real client (config wins)', async () => {
    const { client: runtime } = runtimeStub({
      enabled: true,
      publicKey: 'pk',
      secretKey: 'sk_test_x',
    });
    const provider = new DynamicStripeClientProvider(
      runtime,
      configStub({ NODE_ENV: 'production' }),
    );
    const client = await provider.resolve();
    expect(client).not.toBeInstanceOf(MockBillingProvider);
    expect(client).not.toBeInstanceOf(UnconfiguredStripeClient);
  });

  it('(2) config enabled + secret absent → Unconfigured (boots) + WARN + SecurityEvent', async () => {
    const { client: runtime } = runtimeStub({ enabled: true, publicKey: 'pk', secretKey: null });
    const { svc, publish } = securityStub();
    const provider = new DynamicStripeClientProvider(
      runtime,
      configStub({ NODE_ENV: 'production' }),
      svc,
    );
    const client = await provider.resolve();
    expect(client).toBeInstanceOf(UnconfiguredStripeClient);
    expectFailsClosed(client);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'stripe-enabled-but-keyless' }),
    );
  });

  it('(3) config enabled + sk_live outside production → fail-closed + SecurityEvent (never a live client)', async () => {
    const { client: runtime } = runtimeStub({
      enabled: true,
      publicKey: 'pk',
      secretKey: 'sk_live_x',
    });
    const { svc, publish } = securityStub();
    const provider = new DynamicStripeClientProvider(
      runtime,
      configStub({ NODE_ENV: 'development' }),
      svc,
    );
    const client = await provider.resolve();
    expect(client).toBeInstanceOf(UnconfiguredStripeClient);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'stripe-config-rejected' }),
    );
  });

  it('(4) config disabled + env BILLING_PROVIDER=stripe + key → Real (env fallback)', async () => {
    const { client: runtime } = runtimeStub({ enabled: false, publicKey: null, secretKey: null });
    const provider = new DynamicStripeClientProvider(
      runtime,
      configStub({
        BILLING_PROVIDER: 'stripe',
        STRIPE_SECRET_KEY: 'sk_test_env',
        NODE_ENV: 'production',
      }),
    );
    const client = await provider.resolve();
    expect(client).not.toBeInstanceOf(MockBillingProvider);
    expect(client).not.toBeInstanceOf(UnconfiguredStripeClient);
  });

  it('(5) config disabled + env BILLING_PROVIDER=mock → MockBillingProvider', async () => {
    const { client: runtime } = runtimeStub({ enabled: false, publicKey: null, secretKey: null });
    const provider = new DynamicStripeClientProvider(
      runtime,
      configStub({ BILLING_PROVIDER: 'mock', NODE_ENV: 'production' }),
    );
    expect(await provider.resolve()).toBeInstanceOf(MockBillingProvider);
  });

  it('(6) config unreachable (client threw) → env fallback', async () => {
    const { client: runtime } = runtimeStub(() => Promise.reject(new Error('nats timeout')));
    const provider = new DynamicStripeClientProvider(
      runtime,
      configStub({ BILLING_PROVIDER: 'mock', NODE_ENV: 'production' }),
    );
    expect(await provider.resolve()).toBeInstanceOf(MockBillingProvider);
  });

  it('(7) nothing configured (config disabled + bare env) → Unconfigured fail-closed default', async () => {
    const { client: runtime } = runtimeStub({ enabled: false, publicKey: null, secretKey: null });
    const provider = new DynamicStripeClientProvider(
      runtime,
      configStub({ NODE_ENV: 'production' }),
    );
    const client = await provider.resolve();
    expect(client).toBeInstanceOf(UnconfiguredStripeClient);
    expectFailsClosed(client);
  });
});

describe('DynamicStripeClientProvider — snapshot + invalidation + secret hygiene', () => {
  it('caches the snapshot within the TTL (one config fetch for repeated resolves)', async () => {
    const { client: runtime, spy } = runtimeStub({
      enabled: false,
      publicKey: null,
      secretKey: null,
    });
    const provider = new DynamicStripeClientProvider(
      runtime,
      configStub({ BILLING_PROVIDER: 'mock', NODE_ENV: 'production' }),
    );
    await provider.resolve();
    await provider.resolve();
    await provider.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces a rebuild that picks up new config (runtime swap)', async () => {
    let current: BillingStripeSettings = { enabled: false, publicKey: null, secretKey: null };
    const { client: runtime } = runtimeStub(() => Promise.resolve(current));
    const provider = new DynamicStripeClientProvider(
      runtime,
      configStub({ BILLING_PROVIDER: 'mock', NODE_ENV: 'production' }),
    );
    expect(await provider.resolve()).toBeInstanceOf(MockBillingProvider);

    // Operator saves a real key → ConfigurationChanged → invalidate.
    current = { enabled: true, publicKey: 'pk', secretKey: 'sk_test_new' };
    provider.invalidate();
    const swapped = await provider.resolve();
    expect(swapped).not.toBeInstanceOf(MockBillingProvider);
    expect(swapped).not.toBeInstanceOf(UnconfiguredStripeClient);
  });

  it('never logs the secret value (secret held in memory only)', async () => {
    const secret = 'sk_test_SUPERSECRET_should_never_be_logged';
    const { client: runtime } = runtimeStub({ enabled: true, publicKey: 'pk', secretKey: secret });
    const provider = new DynamicStripeClientProvider(
      runtime,
      configStub({ NODE_ENV: 'production' }),
    );
    const logged: string[] = [];
    const capture = (...parts: unknown[]): void => {
      logged.push(parts.map((p) => String(p)).join(' '));
    };
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(capture);
    }
    await provider.resolve();
    expect(logged.join('\n')).not.toContain(secret);
  });
});
