import type { ServiceIdentityKeyringEntry } from '../../utils/service-identity.util';
import {
  type FeatureEvaluationSnapshot,
  FeatureEvaluationSnapshotError,
  signFeatureEvaluationSnapshot,
  verifyFeatureEvaluationSnapshot,
} from '../feature-evaluation-snapshot';

const NOW_MS = Date.parse('2026-07-20T12:00:00.000Z');
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const ACTIVE_KEY: ServiceIdentityKeyringEntry = {
  kid: 'feature-active',
  secret: 'a'.repeat(32),
  status: 'active',
};
const PREVIOUS_KEY: ServiceIdentityKeyringEntry = {
  kid: 'feature-previous',
  secret: 'b'.repeat(32),
  status: 'previous',
};

describe('feature evaluation snapshot', () => {
  it('signs a tenant/audience-bound snapshot and verifies an active key', () => {
    const snapshot = signFeatureEvaluationSnapshot({
      audience: 'gateway-api',
      tenantId: TENANT_ID,
      evaluations: [{ key: 'marine_explorer', enabled: false }],
      keyring: [ACTIVE_KEY, PREVIOUS_KEY],
      activeKeyId: ACTIVE_KEY.kid,
      nowMs: NOW_MS,
      lifetimeMs: 20_000,
    });

    expect(
      verifyFeatureEvaluationSnapshot(snapshot, {
        keyring: [ACTIVE_KEY, PREVIOUS_KEY],
        expectedAudience: 'gateway-api',
        expectedTenantId: TENANT_ID,
        expectedFeatureKeys: ['marine_explorer'],
        nowMs: NOW_MS + 5_000,
      }),
    ).toEqual(snapshot);
  });

  it('accepts a snapshot signed before rotation while its key is previous', () => {
    const oldActive: ServiceIdentityKeyringEntry = {
      ...PREVIOUS_KEY,
      status: 'active',
    };
    const snapshot = signFeatureEvaluationSnapshot({
      audience: 'farm-service',
      tenantId: TENANT_ID,
      evaluations: [{ key: 'marine_explorer', enabled: true }],
      keyring: [oldActive],
      activeKeyId: oldActive.kid,
      nowMs: NOW_MS,
    });

    expect(
      verifyFeatureEvaluationSnapshot(snapshot, {
        keyring: [ACTIVE_KEY, PREVIOUS_KEY],
        expectedAudience: 'farm-service',
        expectedTenantId: TENANT_ID,
        expectedFeatureKeys: ['marine_explorer'],
        nowMs: NOW_MS + 1,
      }).evaluations[0]?.enabled,
    ).toBe(true);
  });

  it.each([
    [
      'tenant',
      {
        expectedTenantId: OTHER_TENANT_ID,
        expectedAudience: undefined,
        expectedFeatureKeys: undefined,
      },
    ],
    [
      'audience',
      {
        expectedTenantId: undefined,
        expectedAudience: 'farm-service',
        expectedFeatureKeys: undefined,
      },
    ],
    [
      'feature set',
      {
        expectedTenantId: undefined,
        expectedAudience: undefined,
        expectedFeatureKeys: ['another_feature'],
      },
    ],
  ])('rejects a %s mismatch', (_label, override) => {
    const snapshot = createSnapshot();
    expect(() =>
      verifyFeatureEvaluationSnapshot(snapshot, {
        keyring: [ACTIVE_KEY],
        expectedAudience: override.expectedAudience ?? 'gateway-api',
        expectedTenantId: override.expectedTenantId ?? TENANT_ID,
        expectedFeatureKeys: override.expectedFeatureKeys ?? ['marine_explorer'],
        nowMs: NOW_MS + 1,
      }),
    ).toThrow(FeatureEvaluationSnapshotError);
  });

  it('rejects tampering, extra fields, disabled keys, and expiration', () => {
    const snapshot = createSnapshot();
    const tampered = {
      ...snapshot,
      evaluations: [{ key: 'marine_explorer', enabled: true }],
    };
    const withExtraField = { ...snapshot, reason: 'operator policy' };
    const disabledKey: ServiceIdentityKeyringEntry = { ...ACTIVE_KEY, status: 'disabled' };

    const verify = (
      value: unknown,
      keyring: readonly ServiceIdentityKeyringEntry[] = [ACTIVE_KEY],
      nowMs = NOW_MS + 1,
    ): FeatureEvaluationSnapshot =>
      verifyFeatureEvaluationSnapshot(value, {
        keyring,
        expectedAudience: 'gateway-api',
        expectedTenantId: TENANT_ID,
        expectedFeatureKeys: ['marine_explorer'],
        nowMs,
      });

    expect(() => verify(tampered)).toThrow(FeatureEvaluationSnapshotError);
    expect(() => verify(withExtraField)).toThrow(FeatureEvaluationSnapshotError);
    expect(() => verify(snapshot, [disabledKey])).toThrow(FeatureEvaluationSnapshotError);
    expect(() => verify(snapshot, [ACTIVE_KEY], NOW_MS + 30_000)).toThrow(
      FeatureEvaluationSnapshotError,
    );
  });

  it('requires sorted unique evaluations and an explicitly active signing key', () => {
    expect(() =>
      signFeatureEvaluationSnapshot({
        audience: 'gateway-api',
        tenantId: TENANT_ID,
        evaluations: [
          { key: 'z_feature', enabled: false },
          { key: 'a_feature', enabled: false },
        ],
        keyring: [ACTIVE_KEY],
        activeKeyId: ACTIVE_KEY.kid,
        nowMs: NOW_MS,
      }),
    ).toThrow(FeatureEvaluationSnapshotError);

    expect(() =>
      signFeatureEvaluationSnapshot({
        audience: 'gateway-api',
        tenantId: TENANT_ID,
        evaluations: [{ key: 'marine_explorer', enabled: false }],
        keyring: [PREVIOUS_KEY],
        activeKeyId: PREVIOUS_KEY.kid,
        nowMs: NOW_MS,
      }),
    ).toThrow(FeatureEvaluationSnapshotError);
  });
});

function createSnapshot(): FeatureEvaluationSnapshot {
  return signFeatureEvaluationSnapshot({
    audience: 'gateway-api',
    tenantId: TENANT_ID,
    evaluations: [{ key: 'marine_explorer', enabled: false }],
    keyring: [ACTIVE_KEY],
    activeKeyId: ACTIVE_KEY.kid,
    nowMs: NOW_MS,
  });
}
