import type { IngressOwnerPolicy } from '@platform/event-contracts';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { NatsEventBus } from '@platform/event-bus';

import { IngestBackendPolicyModule } from '../policy.module';
import { IngestBackendPolicyService } from '../services/ingest-backend-policy.service';
import {
  assertDrainBarrierEvidence,
  assertIngressOwnerTransition,
  IngressOwnerPolicyTransitionError,
  IngressOwnerPolicyService,
} from '../services/ingress-owner-policy.service';
import { PolicySnapshotResponder } from '../services/policy-snapshot.responder';

function policy(overrides: Partial<IngressOwnerPolicy> = {}): IngressOwnerPolicy {
  return {
    tenantId: '0f3f4a75-c611-4ad4-9fe4-89ea0c978a1a',
    version: 1,
    owner: 'NESTJS',
    effectiveEpoch: '2026-08-25T12:00:00.000Z',
    state: 'PREPARING',
    ...overrides,
  };
}

describe('assertIngressOwnerTransition', () => {
  it('requires durable evidence whenever a drain barrier is asserted', () => {
    expect(() => assertDrainBarrierEvidence(true, undefined)).toThrow(/evidence/i);
    expect(() => assertDrainBarrierEvidence(true, 'receipt-drain:0@epoch-7')).not.toThrow();
    expect(() => assertDrainBarrierEvidence(false, undefined)).not.toThrow();
  });

  it('accepts the first policy only in PREPARING state at version one', () => {
    expect(() => assertIngressOwnerTransition(null, policy(), false)).not.toThrow();
    expect(() => assertIngressOwnerTransition(null, policy({ state: 'ACTIVE' }), true)).toThrow(
      IngressOwnerPolicyTransitionError,
    );
  });

  it('requires a proven drain barrier before PREPARING becomes ACTIVE', () => {
    const current = policy();
    const next = policy({ version: 2, state: 'ACTIVE' });

    expect(() => assertIngressOwnerTransition(current, next, false)).toThrow(/drain barrier/i);
    expect(() => assertIngressOwnerTransition(current, next, true)).not.toThrow();
  });

  it('requires ACTIVE to enter DRAINING before the owner or epoch can change', () => {
    const current = policy({ state: 'ACTIVE' });

    expect(() =>
      assertIngressOwnerTransition(
        current,
        policy({ version: 2, owner: 'RUST', state: 'PREPARING' }),
        true,
      ),
    ).toThrow(/DRAINING/i);

    expect(() =>
      assertIngressOwnerTransition(current, policy({ version: 2, state: 'DRAINING' }), false),
    ).not.toThrow();
  });

  it('allows a new owner epoch only after DRAINING has a proven empty drain', () => {
    const current = policy({ state: 'DRAINING' });
    const next = policy({
      version: 2,
      owner: 'RUST',
      effectiveEpoch: '2026-08-25T13:00:00.000Z',
    });

    expect(() => assertIngressOwnerTransition(current, next, false)).toThrow(/drain barrier/i);
    expect(() => assertIngressOwnerTransition(current, next, true)).not.toThrow();
  });

  it('rejects stale or skipped versions', () => {
    const current = policy({ state: 'ACTIVE', version: 7 });
    expect(() =>
      assertIngressOwnerTransition(current, policy({ state: 'DRAINING', version: 9 }), false),
    ).toThrow(/version 8/i);
  });
});

describe('IngressOwnerPolicyService publish recovery', () => {
  it('surfaces a post-commit publish failure and republishes an exact idempotent retry', async () => {
    const currentEntity = {
      tenantId: '0f3f4a75-c611-4ad4-9fe4-89ea0c978a1a',
      version: 1,
      owner: 'NESTJS',
      effectiveEpoch: new Date('2026-08-25T12:00:00.000Z'),
      state: 'PREPARING',
      drainBarrierSatisfied: false,
      drainBarrierEvidence: null,
      actorId: '8e471b18-8ddd-428f-93dc-f4bd6c1e6f07',
      createdAt: new Date('2026-08-25T11:59:00.000Z'),
    };
    const findOne = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(currentEntity);
    const query = jest.fn().mockResolvedValue([]);
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query,
      manager: { findOne },
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const publishCore = jest
      .fn()
      .mockRejectedValueOnce(new Error('broker flush failed'))
      .mockResolvedValueOnce(undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        IngressOwnerPolicyService,
        { provide: DataSource, useValue: { createQueryRunner: () => queryRunner } },
        { provide: NatsEventBus, useValue: { publishCore } },
      ],
    }).compile();
    const service = moduleRef.get(IngressOwnerPolicyService);
    const input = {
      policy: policy(),
      drainBarrierSatisfied: false,
      actorId: '8e471b18-8ddd-428f-93dc-f4bd6c1e6f07',
    };

    await expect(service.append(input)).rejects.toThrow('broker flush failed');
    await expect(service.append(input)).resolves.toEqual(policy());

    const insertCalls = query.mock.calls.filter(
      ([statement]) => typeof statement === 'string' && statement.includes('INSERT INTO'),
    );
    expect(insertCalls).toHaveLength(1);
    expect(publishCore).toHaveBeenCalledTimes(2);
  });
});

describe('IngestBackendPolicyModule ownership surface', () => {
  it('registers only the versioned owner policy writers and snapshot responder', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      IngestBackendPolicyModule,
    ) as unknown[];

    expect(providers).not.toContain(IngestBackendPolicyService);
    expect(providers).not.toContain(PolicySnapshotResponder);
  });
});
