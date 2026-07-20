import type { ServiceIdentityKeyringEntry } from '../../utils/service-identity.util';
import {
  FailClosedFeatureToggleClient,
  type FeatureEvaluationSnapshotTransport,
} from '../fail-closed-feature-toggle.client';
import {
  signFeatureEvaluationSnapshot,
  type FeatureEvaluationSnapshot,
} from '../feature-evaluation-snapshot';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const KEY: ServiceIdentityKeyringEntry = {
  kid: 'feature-active',
  secret: 'a'.repeat(32),
  status: 'active',
};

describe('FailClosedFeatureToggleClient', () => {
  let nowMs: number;

  beforeEach(() => {
    nowMs = Date.parse('2026-07-20T12:00:00.000Z');
  });

  it('caches a verified result only for the bounded local TTL', async () => {
    const transport = jest.fn(
      ({ tenantId, featureKeys }: Parameters<FeatureEvaluationSnapshotTransport>[0]) =>
        Promise.resolve(signed(tenantId, featureKeys, true, nowMs)),
    );
    const client = createClient(transport, { cacheTtlMs: 1_000 });

    await expect(client.isEnabled(TENANT_ID, 'marine_explorer')).resolves.toBe(true);
    nowMs += 999;
    await expect(client.isEnabled(TENANT_ID, 'marine_explorer')).resolves.toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);

    nowMs += 2;
    await expect(client.isEnabled(TENANT_ID, 'marine_explorer')).resolves.toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each<[string, FeatureEvaluationSnapshotTransport]>([
    ['network failure', () => Promise.reject(new Error('connection refused'))],
    ['malformed JSON', () => Promise.resolve({ enabled: true })],
    [
      'wrong audience',
      ({ tenantId, featureKeys }) =>
        Promise.resolve(
          signFeatureEvaluationSnapshot({
            audience: 'farm-service',
            tenantId,
            evaluations: featureKeys.map((key) => ({ key, enabled: true })),
            keyring: [KEY],
            activeKeyId: KEY.kid,
            nowMs,
          }),
        ),
    ],
  ])('fails closed on %s without exposing stale data', async (_label, transport) => {
    const client = createClient(transport);
    await expect(client.isEnabled(TENANT_ID, 'marine_explorer')).resolves.toBe(false);
  });

  it('briefly caches transport failure as disabled to bound outage retries', async () => {
    const transport = jest.fn().mockRejectedValue(new Error('connection refused'));
    const client = createClient(transport);

    await expect(client.isEnabled(TENANT_ID, 'marine_explorer')).resolves.toBe(false);
    nowMs += 999;
    await expect(client.isEnabled(TENANT_ID, 'marine_explorer')).resolves.toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);

    nowMs += 2;
    await expect(client.isEnabled(TENANT_ID, 'marine_explorer')).resolves.toBe(false);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent identical misses into one transport request', async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = jest.fn(
      async ({ tenantId, featureKeys }: Parameters<FeatureEvaluationSnapshotTransport>[0]) => {
        await blocked;
        return signed(tenantId, featureKeys, true, nowMs);
      },
    );
    const client = createClient(transport);

    const first = client.isEnabled(TENANT_ID, 'marine_explorer');
    const second = client.isEnabled(TENANT_ID, 'marine_explorer');
    release?.();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('bounds the cache and never shares evaluation across tenants', async () => {
    const transport = jest.fn(
      ({ tenantId, featureKeys }: Parameters<FeatureEvaluationSnapshotTransport>[0]) =>
        Promise.resolve(signed(tenantId, featureKeys, tenantId === TENANT_ID, nowMs)),
    );
    const client = createClient(transport, { maxCacheEntries: 1 });

    await expect(client.isEnabled(TENANT_ID, 'marine_explorer')).resolves.toBe(true);
    await expect(client.isEnabled(OTHER_TENANT_ID, 'marine_explorer')).resolves.toBe(false);
    await expect(client.isEnabled(TENANT_ID, 'marine_explorer')).resolves.toBe(true);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('rejects invalid tenant and feature input as disabled without transport', async () => {
    const transport = jest.fn();
    const client = createClient(transport);

    await expect(client.isEnabled('not-a-tenant', 'marine_explorer')).resolves.toBe(false);
    await expect(client.isEnabled(TENANT_ID, '../marine')).resolves.toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });

  function createClient(
    transport: FeatureEvaluationSnapshotTransport,
    overrides: { cacheTtlMs?: number; maxCacheEntries?: number } = {},
  ): FailClosedFeatureToggleClient {
    return new FailClosedFeatureToggleClient({
      audience: 'gateway-api',
      keyring: [KEY],
      transport,
      cacheTtlMs: overrides.cacheTtlMs,
      maxCacheEntries: overrides.maxCacheEntries,
      now: () => nowMs,
    });
  }
});

function signed(
  tenantId: string,
  featureKeys: readonly string[],
  enabled: boolean,
  nowMs: number,
): FeatureEvaluationSnapshot {
  return signFeatureEvaluationSnapshot({
    audience: 'gateway-api',
    tenantId,
    evaluations: featureKeys.map((key) => ({ key, enabled })),
    keyring: [KEY],
    activeKeyId: KEY.kid,
    nowMs,
  });
}
