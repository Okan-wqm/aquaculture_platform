import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RetentionPolicyService } from '../retention-policy.service';
import { LegalHoldDestructiveMutationAuthority } from '../legal-hold-destructive-mutation.authority';
import { ComplianceAuditService } from '../compliance-audit.service';
import { AttachmentObjectPurgeService } from '../attachment-object-purge.service';
import { RetentionPolicy } from '../../entities/retention-policy.entity';
import {
  createMockRepository,
  createMockRetentionPolicy,
  createMockQueryRunner,
  createMockDataSource,
  fakeUuid,
  resetUuidCounter,
  MockRepository,
  MockQueryRunner,
  TENANT_A,
} from '../../../__tests__/test-helpers';

describe('RetentionPolicyService', () => {
  let service: RetentionPolicyService;
  let policyRepo: MockRepository<RetentionPolicy>;
  let mockDataSource: ReturnType<typeof createMockDataSource>;
  let queryRunner: MockQueryRunner;
  let auditService: jest.Mocked<Pick<ComplianceAuditService, 'log'>>;
  let attachmentPurge: { purgeObjects: jest.Mock };

  const userId = fakeUuid('usr');
  const channelId = fakeUuid('ch');
  const cleanupTenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const cleanupTenantIdB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const heldTenantId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  beforeEach(async () => {
    resetUuidCounter();

    policyRepo = createMockRepository<RetentionPolicy>();
    queryRunner = createMockQueryRunner();
    mockDataSource = createMockDataSource(queryRunner);
    queryRunner.manager.query.mockImplementation((sql: string, parameters?: unknown[]) =>
      queryRunner.query(sql, parameters),
    );
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    attachmentPurge = {
      purgeObjects: jest
        .fn()
        .mockResolvedValue({ requested: 0, deleted: 0, skipped: 0, failed: 0 }),
    };

    policyRepo.create.mockImplementation((data: unknown) => data as RetentionPolicy);
    policyRepo.save.mockImplementation((data: unknown) => Promise.resolve(data as RetentionPolicy));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RetentionPolicyService,
        LegalHoldDestructiveMutationAuthority,
        { provide: getRepositoryToken(RetentionPolicy), useValue: policyRepo },
        { provide: DataSource, useValue: mockDataSource },
        { provide: ComplianceAuditService, useValue: auditService },
        { provide: AttachmentObjectPurgeService, useValue: attachmentPurge },
      ],
    }).compile();

    service = module.get(RetentionPolicyService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Sets retention policy for tenant
  // -----------------------------------------------------------------------
  it('creates a new tenant-level retention policy', async () => {
    policyRepo.findOne.mockResolvedValue(null); // no existing policy

    const result = await service.setPolicy(TENANT_A, null, 90, userId);

    expect(policyRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_A,
        channelId: null,
        retentionDays: 90,
        createdBy: userId,
      }),
    );
    expect(policyRepo.save).toHaveBeenCalled();
    expect(result).toHaveProperty('retentionDays', 90);
  });

  it('updates an existing retention policy', async () => {
    const existing = createMockRetentionPolicy({ retentionDays: 365 });
    policyRepo.findOne.mockResolvedValue(existing);

    const result = await service.setPolicy(TENANT_A, null, 90, userId);

    expect(result.retentionDays).toBe(90);
    expect(policyRepo.save).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Channel-level override takes precedence over tenant default
  // -----------------------------------------------------------------------
  it('channel-level override takes precedence over tenant default', async () => {
    // Channel policy: 30 days
    const channelPolicy = createMockRetentionPolicy({
      channelId,
      retentionDays: 30,
    });
    policyRepo.findOne.mockResolvedValue(channelPolicy);

    const days = await service.getEffectiveRetentionDays(TENANT_A, channelId);

    expect(days).toBe(30);
  });

  it('falls back to tenant default when no channel override exists', async () => {
    // First findOne (channel) returns null
    policyRepo.findOne
      .mockResolvedValueOnce(null)
      // Second findOne (tenant default) returns 365
      .mockResolvedValueOnce(createMockRetentionPolicy({ channelId: null, retentionDays: 365 }));

    const days = await service.getEffectiveRetentionDays(TENANT_A, channelId);

    expect(days).toBe(365);
  });

  // -----------------------------------------------------------------------
  // Nightly cleanup — retention actually runs (MSG-HIGH-073 + MT-MEDIUM-054)
  // and purges attachment objects (MSG-CRITICAL-058).
  //
  // NOTE: these assert the control flow over mocked queries. SQL-level
  // correctness (row DELETE semantics, tenant-schema pinning, advisory lock)
  // is exercised by the messaging-service e2e integration suite.
  // -----------------------------------------------------------------------
  interface PolicyRow {
    id: string;
    tenantId: string;
    channelId: string | null;
    retentionDays: number;
  }
  function mockSweep(opts: {
    policies: PolicyRow[];
    attachmentKeys?: Array<{ storageKey: string; thumbnailKey: string | null }>;
    deletedCount?: number;
    heldAfterLock?: boolean;
    heldChannelId?: string | null;
  }): void {
    // listTenantSchemas() → one tenant schema.
    mockDataSource.query.mockResolvedValue([{ schema_name: 'tenant_aaaaaaaaaaaaaaaa' }]);
    queryRunner.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM retention_policies')) return Promise.resolve(opts.policies);
      if (sql.includes('FROM legal_holds')) {
        return Promise.resolve(
          opts.heldAfterLock ? [{ id: 'h1', channelId: opts.heldChannelId ?? null }] : [],
        );
      }
      if (sql.includes('SELECT att."storageKey"'))
        return Promise.resolve(opts.attachmentKeys ?? []);
      if (sql.includes('DELETE FROM messages'))
        return Promise.resolve([[], opts.deletedCount ?? 0]);
      return Promise.resolve([]);
    });
  }
  const sqlCalls = (): string[] => queryRunner.query.mock.calls.map((c) => c[0] as string);

  it('deletes expired messages via a row DELETE, never drop_chunks (MSG-HIGH-073)', async () => {
    mockSweep({
      policies: [{ id: 'p1', tenantId: cleanupTenantId, channelId: null, retentionDays: 90 }],
      deletedCount: 5,
    });
    await service.executeRetentionCleanup();

    const sqls = sqlCalls();
    expect(sqls.some((s) => s.includes('DELETE FROM messages'))).toBe(true);
    expect(sqls.some((s) => s.includes('drop_chunks'))).toBe(false);
  });

  it('reads policies from tenant schemas, not the connection-default template (MT-MEDIUM-054)', async () => {
    mockSweep({
      policies: [{ id: 'p1', tenantId: cleanupTenantId, channelId: null, retentionDays: 90 }],
      deletedCount: 1,
    });

    await service.executeRetentionCleanup();

    expect(mockDataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('information_schema.schemata'),
    );
    expect(sqlCalls().some((s) => s.includes('FROM retention_policies'))).toBe(true);
  });

  it('purges the expired attachment objects after deleting the rows (MSG-CRITICAL-058)', async () => {
    mockSweep({
      policies: [{ id: 'p1', tenantId: cleanupTenantId, channelId: null, retentionDays: 90 }],
      attachmentKeys: [
        { storageKey: 'messaging/t/a.png', thumbnailKey: 'messaging/t/a_thumb.png' },
        { storageKey: 'messaging/t/b.pdf', thumbnailKey: null },
      ],
      deletedCount: 2,
    });
    await service.executeRetentionCleanup();

    expect(attachmentPurge.purgeObjects).toHaveBeenCalledWith(cleanupTenantId, [
      'messaging/t/a.png',
      'messaging/t/a_thumb.png',
      'messaging/t/b.pdf',
    ]);
  });

  it('captures the object keys BEFORE deleting attachment rows, then messages', async () => {
    mockSweep({
      policies: [{ id: 'p1', tenantId: cleanupTenantId, channelId: null, retentionDays: 90 }],
      attachmentKeys: [{ storageKey: 'messaging/t/a.png', thumbnailKey: null }],
      deletedCount: 1,
    });
    await service.executeRetentionCleanup();

    const sqls = sqlCalls();
    const sel = sqls.findIndex((s) => s.includes('SELECT att."storageKey"'));
    const delAtt = sqls.findIndex((s) => s.includes('DELETE FROM message_attachments'));
    const delMsg = sqls.findIndex((s) => s.includes('DELETE FROM messages'));
    expect(sel).toBeGreaterThanOrEqual(0);
    expect(delAtt).toBeGreaterThan(sel);
    expect(delMsg).toBeGreaterThan(delAtt);
  });

  it('skips the delete + purge for a tenant under legal hold', async () => {
    mockSweep({
      policies: [{ id: 'p1', tenantId: heldTenantId, channelId: null, retentionDays: 90 }],
      heldAfterLock: true,
    });

    await service.executeRetentionCleanup();

    expect(sqlCalls().some((s) => s.includes('DELETE FROM messages'))).toBe(false);
    expect(attachmentPurge.purgeObjects).not.toHaveBeenCalled();
  });

  it('runs a channel policy through the same locked authority and blocks its held channel', async () => {
    mockSweep({
      policies: [
        {
          id: 'p-channel',
          tenantId: cleanupTenantId,
          channelId,
          retentionDays: 30,
        },
      ],
      heldAfterLock: true,
      heldChannelId: channelId,
    });

    await service.executeRetentionCleanup();

    expect(sqlCalls().some((sql) => sql.includes('DELETE FROM messages'))).toBe(false);
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: 'p-channel',
        details: expect.objectContaining({ skipReason: 'channel-scoped legal hold' }),
      }),
    );
  });

  it('uses the locked channel snapshot as the tenant-policy SQL exclusion authority', async () => {
    const protectedChannelId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    mockSweep({
      policies: [{ id: 'p1', tenantId: cleanupTenantId, channelId: null, retentionDays: 90 }],
      heldAfterLock: true,
      heldChannelId: protectedChannelId,
      deletedCount: 4,
    });

    await service.executeRetentionCleanup();

    const deleteCall = queryRunner.query.mock.calls.find((call) =>
      String(call[0]).includes('DELETE FROM messages WHERE'),
    );
    expect(deleteCall?.[1]).toEqual([expect.any(String), [protectedChannelId]]);
  });

  it('emits one audit row per policy processed (LEGAL-LOW-002)', async () => {
    mockSweep({
      policies: [
        { id: 'p1', tenantId: cleanupTenantId, channelId: null, retentionDays: 90 },
        { id: 'p2', tenantId: cleanupTenantIdB, channelId: null, retentionDays: 30 },
      ],
      deletedCount: 5,
    });
    await service.executeRetentionCleanup();

    expect(auditService.log).toHaveBeenCalledTimes(2);
    const calls = auditService.log.mock.calls.map((c) => c[0]);
    expect(calls.find((c) => c.tenantId === cleanupTenantId)).toMatchObject({
      tenantId: cleanupTenantId,
      resourceType: 'retention_policy',
      details: expect.objectContaining({
        policyId: 'p1',
        type: 'nightly_cleanup',
        deletedCount: expect.any(Number),
      }),
    });
    expect(calls.find((c) => c.tenantId === cleanupTenantIdB)).toMatchObject({
      tenantId: cleanupTenantIdB,
    });
    for (const c of calls) {
      expect(c.tenantId).not.toBe('00000000-0000-0000-0000-000000000000');
    }
  });

  it('audits the legal-hold skip path with the actual tenant + skipReason', async () => {
    mockSweep({
      policies: [{ id: 'p1', tenantId: heldTenantId, channelId: null, retentionDays: 90 }],
      heldAfterLock: true,
    });

    await service.executeRetentionCleanup();

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: heldTenantId,
        resourceType: 'retention_policy',
        resourceId: 'p1',
        details: expect.objectContaining({
          deletedCount: 0,
          skipReason: expect.stringContaining('legal hold'),
        }),
      }),
    );
  });

  it('skips policies with retentionDays = -1 (indefinite) — no delete, no audit', async () => {
    mockSweep({
      policies: [{ id: 'p1', tenantId: cleanupTenantId, channelId: null, retentionDays: -1 }],
    });

    await service.executeRetentionCleanup();

    expect(sqlCalls().some((s) => s.includes('DELETE FROM messages'))).toBe(false);
    expect(auditService.log).not.toHaveBeenCalled();
  });
});
