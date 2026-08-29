import type { IngressOwnerPolicy } from '@platform/event-contracts';

import { IngressOwnerPolicyRegistry } from '../ingress-owner-policy-consumer.service';

function policy(overrides: Partial<IngressOwnerPolicy> = {}): IngressOwnerPolicy {
  return {
    tenantId: '0f3f4a75-c611-4ad4-9fe4-89ea0c978a1a',
    version: 1,
    owner: 'NESTJS',
    effectiveEpoch: '2026-08-25T12:00:00.000Z',
    state: 'ACTIVE',
    ...overrides,
  };
}

describe('IngressOwnerPolicyRegistry', () => {
  it('fails closed for unknown and transitional tenants', () => {
    const registry = new IngressOwnerPolicyRegistry();
    expect(registry.decide(policy().tenantId)).toBe('INDETERMINATE');

    registry.apply(policy({ state: 'PREPARING' }));
    expect(registry.decide(policy().tenantId)).toBe('INDETERMINATE');
  });

  it('processes only an ACTIVE NESTJS owner and ACK-drops only ACTIVE RUST', () => {
    const registry = new IngressOwnerPolicyRegistry();
    registry.apply(policy());
    expect(registry.decide(policy().tenantId)).toBe('PROCESS');

    registry.apply(policy({ version: 2, owner: 'RUST' }));
    expect(registry.decide(policy().tenantId)).toBe('NOT_OWNER');
  });

  it('rejects stale and conflicting updates without replacing current policy', () => {
    const registry = new IngressOwnerPolicyRegistry();
    registry.apply(policy({ version: 4 }));

    expect(registry.apply(policy({ version: 3, owner: 'RUST' }))).toBe(false);
    expect(registry.apply(policy({ version: 4, owner: 'RUST' }))).toBe(false);
    expect(registry.decide(policy().tenantId)).toBe('PROCESS');
  });

  it('atomically replaces cold-start state from a snapshot', () => {
    const registry = new IngressOwnerPolicyRegistry();
    const first = policy();
    const second = policy({
      tenantId: '856e8bf7-c653-42f7-9fa1-a2d7658011f1',
      owner: 'RUST',
    });
    registry.replaceSnapshot([first, second]);

    expect(registry.decide(first.tenantId)).toBe('PROCESS');
    expect(registry.decide(second.tenantId)).toBe('NOT_OWNER');
  });

  it('fails closed when the authoritative snapshot lease expires', () => {
    const registry = new IngressOwnerPolicyRegistry();
    registry.replaceSnapshot([policy()], 1_000);

    expect(registry.decide(policy().tenantId, 5_999)).toBe('PROCESS');
    registry.apply(policy({ version: 2 }));
    expect(registry.decide(policy().tenantId, 6_001)).toBe('INDETERMINATE');

    registry.mergeSnapshot([policy({ version: 2 })], 6_001);
    expect(registry.decide(policy().tenantId, 6_002)).toBe('PROCESS');
  });
});
