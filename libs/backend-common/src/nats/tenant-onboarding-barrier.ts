import { canonicalWireJsonStringifyV1 } from '@aquaculture/shared-contracts';

import type { TenantOnboardingRequirementSnapshotV1 } from './service-nats-runtime-profiles';

export interface TenantOnboardingRequirementEvidence {
  readonly service: string;
  readonly requirementsDigest: string;
  readonly status: 'ACK' | 'FAILED' | null;
  readonly error: string | null;
  readonly acknowledgedAtMs: number | null;
}

export type TenantOnboardingBarrierDecision =
  | { readonly state: 'READY' }
  | {
      readonly state: 'WAITING';
      readonly missingServices: readonly string[];
      readonly retryAfterMs: number;
    }
  | { readonly state: 'EXPIRED'; readonly missingServices: readonly string[] }
  | {
      readonly state: 'FAILED';
      readonly failures: readonly { service: string; error: string | null }[];
    };

/** Pure decision kernel shared by runtime orchestration and exhaustive tests. */
export function evaluateTenantOnboardingBarrier(
  snapshot: TenantOnboardingRequirementSnapshotV1,
  evidence: readonly TenantOnboardingRequirementEvidence[],
  requestedAtMs: number,
  deadlineAtMs: number,
  nowMs: number,
): TenantOnboardingBarrierDecision {
  const services = evidence.map(({ service }) => service).sort();
  if (new Set(services).size !== services.length) {
    throw new Error('Tenant onboarding evidence contains duplicate services');
  }
  if (
    canonicalWireJsonStringifyV1(services) !==
    canonicalWireJsonStringifyV1([...snapshot.requiredServices])
  ) {
    throw new Error('Tenant onboarding evidence does not equal the durable requirement set');
  }
  if (evidence.some(({ requirementsDigest }) => requirementsDigest !== snapshot.snapshotDigest)) {
    throw new Error('Tenant onboarding evidence requirement digest mismatch');
  }
  if (
    !Number.isFinite(requestedAtMs) ||
    !Number.isFinite(deadlineAtMs) ||
    requestedAtMs >= deadlineAtMs
  ) {
    throw new Error('Tenant onboarding request window is not armed');
  }

  const failures = evidence
    .filter(({ status }) => status === 'FAILED')
    .map(({ service, error }) => ({ service, error }))
    .sort((left, right) => left.service.localeCompare(right.service));
  if (failures.length > 0) {
    return Object.freeze({ state: 'FAILED', failures });
  }

  const missingServices = evidence
    .filter(
      ({ status, acknowledgedAtMs }) =>
        status !== 'ACK' ||
        acknowledgedAtMs === null ||
        acknowledgedAtMs < requestedAtMs ||
        acknowledgedAtMs > deadlineAtMs,
    )
    .map(({ service }) => service)
    .sort();
  if (missingServices.length === 0) {
    return Object.freeze({ state: 'READY' });
  }
  if (nowMs >= deadlineAtMs) {
    return Object.freeze({ state: 'EXPIRED', missingServices });
  }
  return Object.freeze({
    state: 'WAITING',
    missingServices,
    retryAfterMs: Math.min(snapshot.retryIntervalMs, deadlineAtMs - nowMs),
  });
}
