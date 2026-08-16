import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import {
  LegalHoldDestructiveMutationAuthority,
  LegalHoldDestructiveMutationBlocked,
} from '../legal-hold-destructive-mutation.authority';
import {
  createMockDataSource,
  createMockQueryRunner,
  MockQueryRunner,
} from '../../../__tests__/test-helpers';

describe('LegalHoldDestructiveMutationAuthority', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const channelId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  let authority: LegalHoldDestructiveMutationAuthority;
  let queryRunner: MockQueryRunner;

  beforeEach(async () => {
    queryRunner = createMockQueryRunner();
    const moduleRef = await Test.createTestingModule({
      providers: [
        LegalHoldDestructiveMutationAuthority,
        { provide: DataSource, useValue: createMockDataSource(queryRunner) },
      ],
    }).compile();
    authority = moduleRef.get(LegalHoldDestructiveMutationAuthority);
  });

  it('locks first, snapshots active holds, mutates, then commits on one transaction', async () => {
    queryRunner.manager.query.mockResolvedValue([]);
    const resolveTarget = jest.fn().mockResolvedValue({ channelId, target: { id: 'message-1' } });
    const mutate = jest.fn().mockResolvedValue('done');

    const result = await authority.runChannelMutation(tenantId, resolveTarget, mutate);

    expect(result).toBe('done');
    const advisoryCall = queryRunner.query.mock.calls.findIndex((call) =>
      String(call[0]).includes('pg_advisory_xact_lock'),
    );
    expect(advisoryCall).toBeGreaterThanOrEqual(0);
    expect(queryRunner.manager.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM legal_holds'),
      [tenantId],
    );
    expect(mutate).toHaveBeenCalledWith({
      manager: queryRunner.manager,
      target: { id: 'message-1' },
    });
    const advisoryOrder = queryRunner.query.mock.invocationCallOrder[advisoryCall];
    const resolveOrder = resolveTarget.mock.invocationCallOrder[0];
    const snapshotOrder = queryRunner.manager.query.mock.invocationCallOrder[0];
    const mutateOrder = mutate.mock.invocationCallOrder[0];
    expect(advisoryOrder).toBeLessThan(resolveOrder ?? 0);
    expect(resolveOrder).toBeLessThan(snapshotOrder ?? 0);
    expect(snapshotOrder).toBeLessThan(mutateOrder ?? 0);
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('blocks a channel mutation before its callback when an active channel hold exists', async () => {
    queryRunner.manager.query.mockResolvedValue([{ id: 'hold-1', channelId }]);
    const mutate = jest.fn();

    await expect(
      authority.runChannelMutation(
        tenantId,
        () => Promise.resolve({ channelId, target: 'message-1' }),
        mutate,
      ),
    ).rejects.toMatchObject<Partial<LegalHoldDestructiveMutationBlocked>>({
      reason: 'CHANNEL_HOLD',
      holdIds: ['hold-1'],
    });

    expect(mutate).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it('treats isActive as the sole release state and never filters on expiresAt', async () => {
    queryRunner.manager.query.mockResolvedValue([{ id: 'review-overdue-hold', channelId: null }]);

    await expect(
      authority.runPartitionedTenantMutation(tenantId, () => Promise.resolve('unreachable')),
    ).rejects.toMatchObject<Partial<LegalHoldDestructiveMutationBlocked>>({
      reason: 'TENANT_WIDE_HOLD',
    });

    const snapshotSql = String(queryRunner.manager.query.mock.calls[0]?.[0]);
    expect(snapshotSql).toContain('"isActive" = true');
    expect(snapshotSql).not.toContain('expiresAt');
  });

  it('passes a deterministic held-channel exclusion set to partitioned tenant mutations', async () => {
    queryRunner.manager.query.mockResolvedValue([
      { id: 'hold-2', channelId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
      { id: 'hold-1', channelId },
      { id: 'hold-3', channelId },
    ]);

    const result = await authority.runPartitionedTenantMutation(tenantId, ({ heldChannelIds }) =>
      Promise.resolve([...heldChannelIds]),
    );

    expect(result).toEqual([channelId, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd']);
  });

  it('blocks a user erasure when any authored-or-member channel is held', async () => {
    queryRunner.manager.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM legal_holds')) {
        return Promise.resolve([{ id: 'hold-1', channelId }]);
      }
      if (sql.includes('FROM messages WHERE "senderId"')) {
        return Promise.resolve([{ channelId }]);
      }
      return Promise.resolve([]);
    });
    const mutate = jest.fn();

    await expect(authority.runUserMutation(tenantId, userId, mutate)).rejects.toMatchObject<
      Partial<LegalHoldDestructiveMutationBlocked>
    >({
      reason: 'USER_CHANNEL_HOLD',
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('fails closed and rolls back when the hold snapshot shape is invalid', async () => {
    queryRunner.manager.query.mockResolvedValue([{ id: 'hold-without-channel' }]);
    const mutate = jest.fn();

    await expect(authority.runPartitionedTenantMutation(tenantId, mutate)).rejects.toThrow(
      'invalid snapshot row',
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });
});
