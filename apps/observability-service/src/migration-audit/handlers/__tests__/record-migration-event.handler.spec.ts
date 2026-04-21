import { ConfigService } from '@nestjs/config';

import { RecordMigrationEventCommand } from '../../commands/record-migration-event.command';
import { RecordMigrationEventHandler } from '../record-migration-event.handler';
import type { MigrationEventEntity } from '../../../database/entities/migration-event.entity';
import type { MigrationEventRepository } from '../../repositories/migration-event.repository';

function makeRepoMock(): jest.Mocked<MigrationEventRepository> {
  return {
    insert: jest.fn(
      async (e: Omit<MigrationEventEntity, 'id'>) =>
        ({ id: 'test-uuid', ...e }) as MigrationEventEntity,
    ),
    recent: jest.fn(),
  } as unknown as jest.Mocked<MigrationEventRepository>;
}

function makeConfigMock(
  entries: Record<string, string | undefined>,
): ConfigService {
  return {
    get: jest.fn(
      (key: string, defaultValue?: string) =>
        entries[key] ?? defaultValue ?? undefined,
    ),
  } as unknown as ConfigService;
}

describe('RecordMigrationEventHandler', () => {
  it('persists a platform-level event with defaults (no tenant, no error)', async () => {
    const repo = makeRepoMock();
    const cfg = makeConfigMock({ AQUA_ENV: 'staging' });
    const handler = new RecordMigrationEventHandler(repo, cfg);

    const cmd = new RecordMigrationEventCommand({
      serviceName: 'hr',
      migrationName: 'HealHrNullabilityDrift1787000000000',
      eventType: 'applied',
      durationMs: 1234,
    });

    const out = await handler.execute(cmd);
    expect(repo.insert).toHaveBeenCalledTimes(1);
    const call = repo.insert.mock.calls[0]![0]!;
    expect(call.serviceName).toBe('hr');
    expect(call.eventType).toBe('applied');
    expect(call.tenantIdHash).toBeNull();
    expect(call.errorDetail).toBeNull();
    expect(call.environment).toBe('staging');
    expect(call.durationMs).toBe(1234);
    expect(out.id).toBe('test-uuid');
  });

  it('hashes tenantSchema via HMAC pepper (no cleartext persisted)', async () => {
    const repo = makeRepoMock();
    const cfg = makeConfigMock({});
    const handler = new RecordMigrationEventHandler(repo, cfg);

    await handler.execute(
      new RecordMigrationEventCommand({
        serviceName: 'hr',
        migrationName: 'SyncHrEntitiesToDb1786800000000',
        eventType: 'applied',
        tenantSchema: 'tenant_1234567890abcdef',
      }),
    );

    const call = repo.insert.mock.calls[0]![0]!;
    expect(call.tenantIdHash).toBeDefined();
    expect(call.tenantIdHash).not.toBeNull();
    // HMAC-SHA256 hex output = 64 chars
    expect(call.tenantIdHash!.length).toBe(64);
    // Must NOT contain the cleartext tenant schema anywhere
    const serialized = JSON.stringify(call);
    expect(serialized).not.toContain('tenant_1234567890abcdef');
  });

  it('hash is deterministic for a given tenantSchema (dev pepper reproducibility)', async () => {
    const repo1 = makeRepoMock();
    const repo2 = makeRepoMock();
    const cfg = makeConfigMock({});
    const handler1 = new RecordMigrationEventHandler(repo1, cfg);
    const handler2 = new RecordMigrationEventHandler(repo2, cfg);

    const cmd = new RecordMigrationEventCommand({
      serviceName: 'hr',
      migrationName: 'X',
      eventType: 'applied',
      tenantSchema: 'tenant_deadbeefcafebabe',
    });
    await handler1.execute(cmd);
    await handler2.execute(cmd);

    expect(repo1.insert.mock.calls[0]![0]!.tenantIdHash).toBe(
      repo2.insert.mock.calls[0]![0]!.tenantIdHash,
    );
  });

  it('sanitizes PG errors before persisting error_detail (row-leak stripped)', async () => {
    const repo = makeRepoMock();
    const cfg = makeConfigMock({});
    const handler = new RecordMigrationEventHandler(repo, cfg);

    const pgError = Object.assign(
      new Error(
        'duplicate key value violates unique constraint "pk_employees"\nDETAIL:  Key (ssn)=(123-45-6789) already exists.',
      ),
      { code: '23505', constraint: 'pk_employees' },
    );

    await handler.execute(
      new RecordMigrationEventCommand({
        serviceName: 'hr',
        migrationName: 'HealHrNullabilityDrift',
        eventType: 'failed',
        error: pgError,
      }),
    );

    const call = repo.insert.mock.calls[0]![0]!;
    expect(call.errorDetail).not.toBeNull();
    const detail = call.errorDetail as Record<string, unknown>;
    expect(detail.sqlState).toBe('23505');
    expect(detail.constraintName).toBe('pk_employees');
    // Raw SSN must NOT appear anywhere in the persisted record
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain('123-45-6789');
    expect(serialized).not.toMatch(/Key \([^)]+\)=\([^)]+\)/);
  });

  it('defaults environment to development when AQUA_ENV unset', async () => {
    const repo = makeRepoMock();
    const cfg = makeConfigMock({});
    const handler = new RecordMigrationEventHandler(repo, cfg);

    await handler.execute(
      new RecordMigrationEventCommand({
        serviceName: 'hr',
        migrationName: 'X',
        eventType: 'skipped',
      }),
    );

    const call = repo.insert.mock.calls[0]![0]!;
    expect(call.environment).toBe('development');
  });

  it('routes validator_warn / validator_error events correctly', async () => {
    const repo = makeRepoMock();
    const cfg = makeConfigMock({ AQUA_ENV: 'production' });
    const handler = new RecordMigrationEventHandler(repo, cfg);

    await handler.execute(
      new RecordMigrationEventCommand({
        serviceName: 'hr',
        migrationName: '',
        eventType: 'validator_warn',
        driftClassId: 'orphan_column',
      }),
    );

    const call = repo.insert.mock.calls[0]![0]!;
    expect(call.eventType).toBe('validator_warn');
    expect(call.driftClassId).toBe('orphan_column');
    expect(call.migrationName).toBe('');
  });

  it('persists pre-sanitized errorDetail verbatim (NATS consumer path)', async () => {
    const repo = makeRepoMock();
    const cfg = makeConfigMock({});
    const handler = new RecordMigrationEventHandler(repo, cfg);

    await handler.execute(
      new RecordMigrationEventCommand({
        serviceName: 'hr',
        migrationName: 'M',
        eventType: 'failed',
        errorDetail: {
          sqlState: '23505',
          template: 'unique constraint violation',
          constraintName: 'pk_employees',
          relation: 'hr.employees',
        },
      }),
    );
    const call = repo.insert.mock.calls[0]![0]!;
    expect(call.errorDetail).toEqual({
      sqlState: '23505',
      template: 'unique constraint violation',
      constraintName: 'pk_employees',
      relation: 'hr.employees',
    });
  });

  it('throws when payload carries BOTH error and errorDetail (ambiguity)', async () => {
    const repo = makeRepoMock();
    const cfg = makeConfigMock({});
    const handler = new RecordMigrationEventHandler(repo, cfg);

    await expect(
      handler.execute(
        new RecordMigrationEventCommand({
          serviceName: 'hr',
          migrationName: 'M',
          eventType: 'failed',
          error: new Error('raw'),
          errorDetail: {
            sqlState: '23505',
            template: 'x',
            constraintName: null,
            relation: null,
          },
        }),
      ),
    ).rejects.toThrow(/ambiguous/);
  });

  it('uses provided occurredAt when given (preserves orchestrator clock)', async () => {
    const repo = makeRepoMock();
    const cfg = makeConfigMock({});
    const handler = new RecordMigrationEventHandler(repo, cfg);

    const when = new Date('2026-04-21T10:00:00.000Z');
    await handler.execute(
      new RecordMigrationEventCommand({
        serviceName: 'hr',
        migrationName: 'X',
        eventType: 'start',
        occurredAt: when,
      }),
    );

    const call = repo.insert.mock.calls[0]![0]!;
    expect(call.occurredAt.toISOString()).toBe('2026-04-21T10:00:00.000Z');
  });
});
