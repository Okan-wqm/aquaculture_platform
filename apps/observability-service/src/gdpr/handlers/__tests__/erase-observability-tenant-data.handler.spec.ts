import { Repository } from 'typeorm';

import { EraseObservabilityTenantDataCommand } from '../../commands/erase-observability-tenant-data.command';
import { EraseObservabilityTenantDataHandler } from '../erase-observability-tenant-data.handler';
import type { MigrationEventEntity } from '../../../database/entities/migration-event.entity';

function makeRepoMock(
  countByHash: Map<string, number>,
): {
  repo: jest.Mocked<Repository<MigrationEventEntity>>;
  deleteCalls: Array<{ tenantIdHash: string }>;
} {
  const deleteCalls: Array<{ tenantIdHash: string }> = [];
  const repo = {
    count: jest.fn(async (opts: { where: { tenantIdHash: string } }) => {
      return countByHash.get(opts.where.tenantIdHash) ?? 0;
    }),
    delete: jest.fn(
      async (criteria: { tenantIdHash: string }) => {
        deleteCalls.push(criteria);
        return { affected: countByHash.get(criteria.tenantIdHash) ?? 0 };
      },
    ),
  } as unknown as jest.Mocked<Repository<MigrationEventEntity>>;
  return { repo, deleteCalls };
}

describe('EraseObservabilityTenantDataHandler', () => {
  it('counts matching rows + returns the count on dryRun=true', async () => {
    const { repo, deleteCalls } = makeRepoMock(new Map());
    const handler = new EraseObservabilityTenantDataHandler(repo);

    // First compute the hash so we can seed the mock.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { hmacTenantHash } = require('@aquaculture/backend-common') as {
      hmacTenantHash: (s: string) => string;
    };
    const hash = hmacTenantHash('tenant_1234567890abcdef');
    (repo.count as jest.Mock).mockResolvedValue(7);

    const result = await handler.execute(
      new EraseObservabilityTenantDataCommand({
        tenantSchema: 'tenant_1234567890abcdef',
        dryRun: true,
      }),
    );

    expect(result.matchedCount).toBe(7);
    expect(result.deletedCount).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(result.tenantIdHash).toBe(hash);
    expect(deleteCalls).toEqual([]);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('deletes matching rows when dryRun=false (default)', async () => {
    const { repo } = makeRepoMock(new Map());
    (repo.count as jest.Mock).mockResolvedValue(5);
    (repo.delete as jest.Mock).mockResolvedValue({ affected: 5 });
    const handler = new EraseObservabilityTenantDataHandler(repo);

    const result = await handler.execute(
      new EraseObservabilityTenantDataCommand({
        tenantSchema: 'tenant_deadbeefcafebabe',
      }),
    );

    expect(result.matchedCount).toBe(5);
    expect(result.deletedCount).toBe(5);
    expect(result.dryRun).toBe(false);
    expect(repo.delete).toHaveBeenCalledTimes(1);
    const deleteCall = (repo.delete as jest.Mock).mock.calls[0]![0] as {
      tenantIdHash: string;
    };
    expect(deleteCall.tenantIdHash.length).toBe(64);
  });

  it('persists tenant schema as HMAC hash — never cleartext', async () => {
    const { repo } = makeRepoMock(new Map());
    (repo.count as jest.Mock).mockResolvedValue(0);
    (repo.delete as jest.Mock).mockResolvedValue({ affected: 0 });
    const handler = new EraseObservabilityTenantDataHandler(repo);

    await handler.execute(
      new EraseObservabilityTenantDataCommand({
        tenantSchema: 'tenant_aaaabbbbccccdddd',
      }),
    );

    // Verify neither count nor delete ever received the cleartext schema.
    const countCalls = (repo.count as jest.Mock).mock.calls;
    const deleteCalls = (repo.delete as jest.Mock).mock.calls;
    for (const c of [...countCalls, ...deleteCalls]) {
      const serialized = JSON.stringify(c);
      expect(serialized).not.toContain('tenant_aaaabbbbccccdddd');
    }
  });

  it('rejects non-string tenantSchema', async () => {
    const { repo } = makeRepoMock(new Map());
    const handler = new EraseObservabilityTenantDataHandler(repo);
    await expect(
      handler.execute(
        new EraseObservabilityTenantDataCommand({
          tenantSchema: '' as unknown as string,
        }),
      ),
    ).rejects.toThrow(/non-empty string/);
  });

  it('reports deletedCount 0 when no rows match', async () => {
    const { repo } = makeRepoMock(new Map());
    (repo.count as jest.Mock).mockResolvedValue(0);
    (repo.delete as jest.Mock).mockResolvedValue({ affected: 0 });
    const handler = new EraseObservabilityTenantDataHandler(repo);

    const result = await handler.execute(
      new EraseObservabilityTenantDataCommand({
        tenantSchema: 'tenant_0000000000000000',
      }),
    );
    expect(result.matchedCount).toBe(0);
    expect(result.deletedCount).toBe(0);
  });
});
