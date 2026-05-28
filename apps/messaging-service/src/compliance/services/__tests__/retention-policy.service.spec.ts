import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RetentionPolicyService } from '../retention-policy.service';
import { LegalHoldService } from '../legal-hold.service';
import { ComplianceAuditService } from '../compliance-audit.service';
import { RetentionPolicy } from '../../entities/retention-policy.entity';
import { Message } from '../../../message/entities/message.entity';
import {
  createMockRepository,
  createMockRetentionPolicy,
  createMockQueryRunner,
  createMockDataSource,
  fakeUuid,
  resetUuidCounter,
  MockRepository,
  MockQueryRunner,
} from '../../../__tests__/test-helpers';

describe('RetentionPolicyService', () => {
  let service: RetentionPolicyService;
  let policyRepo: MockRepository<RetentionPolicy>;
  let messageRepo: MockRepository<Message>;
  let mockDataSource: ReturnType<typeof createMockDataSource>;
  let queryRunner: MockQueryRunner;
  let legalHoldService: jest.Mocked<
    Pick<LegalHoldService, 'isUnderLegalHold' | 'getHeldChannelIds'>
  >;
  let auditService: jest.Mocked<Pick<ComplianceAuditService, 'log'>>;

  const userId = fakeUuid('usr');
  const channelId = fakeUuid('ch');
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const tenantId2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const heldTenantId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  beforeEach(async () => {
    resetUuidCounter();

    policyRepo = createMockRepository<RetentionPolicy>();
    messageRepo = createMockRepository<Message>();
    queryRunner = createMockQueryRunner();
    mockDataSource = createMockDataSource(queryRunner);
    legalHoldService = {
      isUnderLegalHold: jest.fn().mockResolvedValue(false),
      getHeldChannelIds: jest.fn().mockResolvedValue([]),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };

    policyRepo.create.mockImplementation(
      (data: unknown) => data as RetentionPolicy,
    );
    policyRepo.save.mockImplementation(
      (data: unknown) => Promise.resolve(data as RetentionPolicy),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RetentionPolicyService,
        { provide: getRepositoryToken(RetentionPolicy), useValue: policyRepo },
        { provide: getRepositoryToken(Message), useValue: messageRepo },
        { provide: DataSource, useValue: mockDataSource },
        { provide: LegalHoldService, useValue: legalHoldService },
        { provide: ComplianceAuditService, useValue: auditService },
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

    const result = await service.setPolicy(tenantId, null, 90, userId);

    expect(policyRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
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

    const result = await service.setPolicy(tenantId, null, 90, userId);

    expect(result.retentionDays).toBe(90);
    expect(policyRepo.save).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Channel-level override takes precedence over tenant default
  // -----------------------------------------------------------------------
  it('channel-level override takes precedence over tenant default', async () => {
    // Channel policy: 30 days
    const channelPolicy = createMockRetentionPolicy({
      tenantId,
      channelId,
      retentionDays: 30,
    });
    policyRepo.findOne.mockResolvedValue(channelPolicy);

    const days = await service.getEffectiveRetentionDays(tenantId, channelId);

    expect(days).toBe(30);
  });

  it('falls back to tenant default when no channel override exists', async () => {
    // First findOne (channel) returns null
    policyRepo.findOne
      .mockResolvedValueOnce(null)
      // Second findOne (tenant default) returns 365
      .mockResolvedValueOnce(
        createMockRetentionPolicy({ channelId: null, retentionDays: 365 }),
      );

    const days = await service.getEffectiveRetentionDays(tenantId, channelId);

    expect(days).toBe(365);
  });

  // -----------------------------------------------------------------------
  // Nightly cleanup deletes expired messages
  // -----------------------------------------------------------------------
  it('deletes expired messages during nightly cleanup', async () => {
    // Channel-scoped policy → slow path (row DELETE via
    // queryRunner). Tenant-wide policies take the dropChunks
    // TimescaleDB fast path which doesn't run a DELETE query.
    const policy = createMockRetentionPolicy({
      tenantId,
      retentionDays: 90,
      channelId,
    });
    policyRepo.find.mockResolvedValue([policy]);
    legalHoldService.isUnderLegalHold.mockResolvedValue(false);

    queryRunner.query.mockResolvedValue([{ drop_chunks: 'chunk_1' }]);

    await service.executeRetentionCleanup();

    // Channel-scoped cleanup uses the row-delete path.
    const queryCalls = queryRunner.query.mock.calls;
    const deleteCall = queryCalls.find((call) => {
      const sql = call[0] as string;
      return sql.includes('DELETE FROM messages');
    });
    expect(deleteCall).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Skips messages under legal hold
  // -----------------------------------------------------------------------
  it('skips cleanup for tenant under legal hold', async () => {
    const policy = createMockRetentionPolicy({
      tenantId,
      retentionDays: 90,
      channelId: null,
    });
    policyRepo.find.mockResolvedValue([policy]);
    legalHoldService.isUnderLegalHold.mockResolvedValue(true);

    await service.executeRetentionCleanup();

    // queryRunner should not have been used for DELETE
    expect(queryRunner.query).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Cascades deletion to attachments
  // -----------------------------------------------------------------------
  it('deletes attachments before deleting messages', async () => {
    // Channel-scoped policy → slow path (DELETE FROM
    // message_attachments runs only on the row-DELETE branch).
    const policy = createMockRetentionPolicy({
      tenantId,
      retentionDays: 30,
      channelId,
    });
    policyRepo.find.mockResolvedValue([policy]);
    legalHoldService.isUnderLegalHold.mockResolvedValue(false);
    queryRunner.query.mockResolvedValue([]);

    await service.executeRetentionCleanup();

    const queryCalls = queryRunner.query.mock.calls;
    const attachmentDropIndex = queryCalls.findIndex((call) => {
      const sql = call[0] as string;
      return sql.includes('DELETE FROM message_attachments');
    });
    const messageDropIndex = queryCalls.findIndex((call) => {
      const sql = call[0] as string;
      return sql.includes('DELETE FROM messages');
    });
    expect(attachmentDropIndex).toBeGreaterThanOrEqual(0);
    expect(messageDropIndex).toBeGreaterThan(attachmentDropIndex);
  });

  // -----------------------------------------------------------------------
  // LEGAL-LOW-002 cure: per-policy audit attribution (was: single
  // anonymous zero-UUID system row for the whole sweep, untraceable
  // per tenant). Now: one row per (tenantId, policyId) processed,
  // with deleted count + skip reason.
  // -----------------------------------------------------------------------
  it('emits one audit row per policy processed (LEGAL-LOW-002)', async () => {
    const tenant1Policy = createMockRetentionPolicy({
      tenantId,
      retentionDays: 90,
    });
    const tenant2Policy = createMockRetentionPolicy({
      tenantId: tenantId2,
      retentionDays: 30,
    });
    policyRepo.find.mockResolvedValue([tenant1Policy, tenant2Policy]);
    legalHoldService.isUnderLegalHold.mockResolvedValue(false);
    queryRunner.query.mockResolvedValue([[], 5]);

    await service.executeRetentionCleanup();

    // Audit called twice — once per policy.
    expect(auditService.log).toHaveBeenCalledTimes(2);

    // Each audit row carries the real tenantId, the policy.id as
    // resourceId, and the per-policy deletedCount inside details.
    const calls = auditService.log.mock.calls.map((c) => c[0]);
    expect(calls.find((c) => c.tenantId === tenantId)).toMatchObject({
      tenantId,
      resourceType: 'retention_policy',
      details: expect.objectContaining({
        policyId: tenant1Policy.id,
        type: 'nightly_cleanup',
        deletedCount: expect.any(Number),
      }),
    });
    expect(calls.find((c) => c.tenantId === tenantId2)).toMatchObject({
      tenantId: tenantId2,
      resourceType: 'retention_policy',
      details: expect.objectContaining({
        policyId: tenant2Policy.id,
      }),
    });

    // No row carries the legacy zero-UUID hardcode.
    for (const call of calls) {
      expect(call.tenantId).not.toBe(
        '00000000-0000-0000-0000-000000000000',
      );
    }
  });

  it('audits the legal-hold skip path with the actual tenant + skipReason', async () => {
    const policy = createMockRetentionPolicy({
      tenantId: heldTenantId,
      retentionDays: 90,
      channelId: null,
    });
    policyRepo.find.mockResolvedValue([policy]);
    legalHoldService.isUnderLegalHold.mockResolvedValue(true);

    await service.executeRetentionCleanup();

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: heldTenantId,
        resourceType: 'retention_policy',
        resourceId: policy.id,
        details: expect.objectContaining({
          deletedCount: 0,
          skipReason: expect.stringContaining('legal hold'),
        }),
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Skips indefinite retention policies
  // -----------------------------------------------------------------------
  it('skips policies with retentionDays = -1 (indefinite)', async () => {
    const indefinitePolicy = createMockRetentionPolicy({ tenantId, retentionDays: -1 });
    policyRepo.find.mockResolvedValue([indefinitePolicy]);

    await service.executeRetentionCleanup();

    // No queryRunner interaction for indefinite policies
    expect(queryRunner.query).not.toHaveBeenCalled();
  });
});
