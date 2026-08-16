import { createTenantOnboardingRequirementSnapshot } from '../service-nats-runtime-profiles';
import {
  evaluateTenantOnboardingBarrier,
  type TenantOnboardingRequirementEvidence,
} from '../tenant-onboarding-barrier';

describe('tenant onboarding barrier decision kernel', () => {
  const base = createTenantOnboardingRequirementSnapshot();
  const snapshot = {
    ...base,
    requiredServices: ['farm-service', 'sensor-service'],
  };
  const evidence = (
    farm: TenantOnboardingRequirementEvidence['status'],
    sensor: TenantOnboardingRequirementEvidence['status'],
  ): TenantOnboardingRequirementEvidence[] => [
    {
      service: 'farm-service',
      requirementsDigest: snapshot.snapshotDigest,
      status: farm,
      error: farm === 'FAILED' ? 'farm failed' : null,
      acknowledgedAtMs: farm === null ? null : 1_500,
    },
    {
      service: 'sensor-service',
      requirementsDigest: snapshot.snapshotDigest,
      status: sensor,
      error: sensor === 'FAILED' ? 'sensor failed' : null,
      acknowledgedAtMs: sensor === null ? null : 1_500,
    },
  ];

  it.each([
    [null, null],
    ['ACK', null],
    [null, 'ACK'],
  ] as const)('never reaches READY for incomplete outcome %s/%s', (farm, sensor) => {
    expect(
      evaluateTenantOnboardingBarrier(snapshot, evidence(farm, sensor), 1_000, 2_000, 1_000),
    ).toEqual(expect.objectContaining({ state: 'WAITING' }));
  });

  it.each([
    ['FAILED', null],
    ['FAILED', 'ACK'],
    ['ACK', 'FAILED'],
    ['FAILED', 'FAILED'],
  ] as const)('makes every FAILED permutation terminal for %s/%s', (farm, sensor) => {
    expect(
      evaluateTenantOnboardingBarrier(snapshot, evidence(farm, sensor), 1_000, 2_000, 1_000),
    ).toEqual(expect.objectContaining({ state: 'FAILED' }));
  });

  it('reaches READY only for the exact complete ACK set, independent of row order', () => {
    const complete = evidence('ACK', 'ACK');
    expect(evaluateTenantOnboardingBarrier(snapshot, complete, 1_000, 2_000, 1_000)).toEqual({
      state: 'READY',
    });
    expect(
      evaluateTenantOnboardingBarrier(snapshot, [...complete].reverse(), 1_000, 2_000, 1_000),
    ).toEqual({ state: 'READY' });
  });

  it('expires incomplete evidence at the durable deadline', () => {
    expect(
      evaluateTenantOnboardingBarrier(snapshot, evidence('ACK', null), 1_000, 2_000, 2_000),
    ).toEqual({ state: 'EXPIRED', missingServices: ['sensor-service'] });
  });

  it('treats an ACK recorded after the deadline as missing', () => {
    const late = evidence('ACK', 'ACK').map((item) =>
      item.service === 'sensor-service' ? { ...item, acknowledgedAtMs: 2_001 } : item,
    );
    expect(evaluateTenantOnboardingBarrier(snapshot, late, 1_000, 2_000, 2_100)).toEqual({
      state: 'EXPIRED',
      missingServices: ['sensor-service'],
    });
  });

  it('fails closed for missing, duplicate, or wrong-digest requirement evidence', () => {
    const complete = evidence('ACK', 'ACK');
    const first = complete[0];
    if (!first) {
      throw new Error('test evidence is empty');
    }
    expect(() =>
      evaluateTenantOnboardingBarrier(snapshot, complete.slice(0, 1), 1_000, 2_000, 1_000),
    ).toThrow('does not equal');
    expect(() =>
      evaluateTenantOnboardingBarrier(snapshot, [first, first], 1_000, 2_000, 1_000),
    ).toThrow('duplicate services');
    expect(() =>
      evaluateTenantOnboardingBarrier(
        snapshot,
        complete.map((item) => ({ ...item, requirementsDigest: 'wrong' })),
        1_000,
        2_000,
        1_000,
      ),
    ).toThrow('digest mismatch');
  });

  it('treats a pre-request ACK as missing evidence', () => {
    const early = evidence('ACK', 'ACK').map((item) => ({ ...item, acknowledgedAtMs: 999 }));
    expect(evaluateTenantOnboardingBarrier(snapshot, early, 1_000, 2_000, 1_500)).toEqual({
      state: 'WAITING',
      missingServices: ['farm-service', 'sensor-service'],
      retryAfterMs: 500,
    });
  });
});
