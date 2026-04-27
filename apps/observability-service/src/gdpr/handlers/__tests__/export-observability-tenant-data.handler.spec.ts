import { Repository } from 'typeorm';

import { ExportObservabilityTenantDataCommand } from '../../commands/export-observability-tenant-data.command';
import { ExportObservabilityTenantDataHandler } from '../export-observability-tenant-data.handler';
import type { MigrationEventEntity } from '../../../database/entities/migration-event.entity';

function makeRepoMock(
  rows: MigrationEventEntity[],
): jest.Mocked<Repository<MigrationEventEntity>> {
  return {
    find: jest.fn(async () => rows),
  } as unknown as jest.Mocked<Repository<MigrationEventEntity>>;
}

function makeRow(
  overrides: Partial<MigrationEventEntity> = {},
): MigrationEventEntity {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    occurredAt: new Date('2026-04-21T00:00:00.000Z'),
    serviceName: 'hr',
    migrationName: 'X',
    eventType: 'applied',
    tenantIdHash: 'a'.repeat(64),
    driftClassId: null,
    durationMs: 100,
    errorDetail: null,
    environment: 'staging',
    ...overrides,
  } as MigrationEventEntity;
}

describe('ExportObservabilityTenantDataHandler', () => {
  it('returns the tenant-scoped rows as structured events', async () => {
    const row = makeRow();
    const repo = makeRepoMock([row]);
    const handler = new ExportObservabilityTenantDataHandler(repo);

    const result = await handler.execute(
      new ExportObservabilityTenantDataCommand({
        tenantSchema: 'tenant_deadbeefcafebabe',
      }),
    );

    expect(result.count).toBe(1);
    expect(result.events[0]).toEqual({
      occurredAt: row.occurredAt,
      serviceName: 'hr',
      migrationName: 'X',
      eventType: 'applied',
      driftClassId: null,
      durationMs: 100,
      environment: 'staging',
      hadError: false,
    });
    expect(result.tenantIdHash.length).toBe(64);
    expect(result.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('omits error_detail content but signals hadError=true when the row had one', async () => {
    const row = makeRow({
      errorDetail: { sqlState: '23505', template: 'unique violation' },
    });
    const repo = makeRepoMock([row]);
    const handler = new ExportObservabilityTenantDataHandler(repo);

    const result = await handler.execute(
      new ExportObservabilityTenantDataCommand({
        tenantSchema: 'tenant_cafecafecafecafe',
      }),
    );

    expect(result.events[0]!.hadError).toBe(true);
    // No error_detail field in the returned shape.
    expect(result.events[0]).not.toHaveProperty('errorDetail');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('23505');
    expect(serialized).not.toContain('unique violation');
  });

  it('passes occurredAt time-range filter through to the repository', async () => {
    const repo = makeRepoMock([]);
    const handler = new ExportObservabilityTenantDataHandler(repo);
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-04-21T00:00:00.000Z');

    await handler.execute(
      new ExportObservabilityTenantDataCommand({
        tenantSchema: 'tenant_0000111122223333',
        fromOccurredAt: from,
        toOccurredAt: to,
      }),
    );

    const call = (repo.find as jest.Mock).mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(call.where['tenantIdHash']).toBeDefined();
    expect(call.where['occurredAt']).toBeDefined();
  });

  it('rejects non-string tenantSchema', async () => {
    const repo = makeRepoMock([]);
    const handler = new ExportObservabilityTenantDataHandler(repo);
    await expect(
      handler.execute(
        new ExportObservabilityTenantDataCommand({
          tenantSchema: null as unknown as string,
        }),
      ),
    ).rejects.toThrow(/non-empty string/);
  });

  it('HMAC-hashes tenantSchema — cleartext never reaches the find call', async () => {
    const repo = makeRepoMock([]);
    const handler = new ExportObservabilityTenantDataHandler(repo);
    await handler.execute(
      new ExportObservabilityTenantDataCommand({
        tenantSchema: 'tenant_4444555566667777',
      }),
    );
    const call = (repo.find as jest.Mock).mock.calls[0]![0];
    const serialized = JSON.stringify(call);
    expect(serialized).not.toContain('tenant_4444555566667777');
  });

  it('returns count=0 when no rows match', async () => {
    const repo = makeRepoMock([]);
    const handler = new ExportObservabilityTenantDataHandler(repo);
    const result = await handler.execute(
      new ExportObservabilityTenantDataCommand({
        tenantSchema: 'tenant_aaaabbbbccccdddd',
      }),
    );
    expect(result.count).toBe(0);
    expect(result.events).toEqual([]);
  });
});
