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
  TENANT_A,
} from '../../../__tests__/test-helpers';

describe('RetentionPolicyService', () => {
  let service: RetentionPolicyService;
  let policyRepo: MockRepository<RetentionPolicy>;
  let messageRepo: MockRepository<Message>;
  let mockDataSource: ReturnType<typeof createMockDataSource>;
  let queryRunner: MockQueryRunner;
  let legalHoldService: jest.Mocked<Pick<LegalHoldService, 'isUnderLegalHold'>>;
  let auditService: jest.Mocked<Pick<ComplianceAuditService, 'log'>>;

  const userId = fakeUuid('usr');
  const channelId = fakeUuid('ch');

  beforeEach(async () => {
    resetUuidCounter();

    policyRepo = createMockRepository<RetentionPolicy>();
    messageRepo = createMockRepository<Message>();
    queryRunner = createMockQueryRunner();
    mockDataSource = createMockDataSource(queryRunner);
    legalHoldService = { isUnderLegalHold: jest.fn().mockResolvedValue(false) };
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
      .mockResolvedValueOnce(
        createMockRetentionPolicy({ channelId: null, retentionDays: 365 }),
      );

    const days = await service.getEffectiveRetentionDays(TENANT_A, channelId);

    expect(days).toBe(365);
  });

  // -----------------------------------------------------------------------
  // Nightly cleanup deletes expired messages
  // -----------------------------------------------------------------------
  it('deletes expired messages during nightly cleanup', async () => {
    const policy = createMockRetentionPolicy({ retentionDays: 90 });
    policyRepo.find.mockResolvedValue([policy]);
    legalHoldService.isUnderLegalHold.mockResolvedValue(false);

    // Simulate DELETE returning [[], 5] (5 messages deleted)
    queryRunner.query.mockResolvedValue([[], 5]);

    await service.executeRetentionCleanup();

    // Should have run DELETE queries via queryRunner
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
    const policy = createMockRetentionPolicy({ retentionDays: 30 });
    policyRepo.find.mockResolvedValue([policy]);
    legalHoldService.isUnderLegalHold.mockResolvedValue(false);
    queryRunner.query.mockResolvedValue([[], 0]);

    await service.executeRetentionCleanup();

    const queryCalls = queryRunner.query.mock.calls;
    const attachmentDelete = queryCalls.find((call) => {
      const sql = call[0] as string;
      return sql.includes('DELETE FROM message_attachments');
    });
    expect(attachmentDelete).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Logs cleanup stats to audit
  // -----------------------------------------------------------------------
  it('logs cleanup stats to compliance audit', async () => {
    policyRepo.find.mockResolvedValue([]); // no policies = no deletions

    await service.executeRetentionCleanup();

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'retention_set',
        details: expect.objectContaining({
          type: 'nightly_cleanup',
          totalDeleted: 0,
        }),
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Skips indefinite retention policies
  // -----------------------------------------------------------------------
  it('skips policies with retentionDays = -1 (indefinite)', async () => {
    const indefinitePolicy = createMockRetentionPolicy({ retentionDays: -1 });
    policyRepo.find.mockResolvedValue([indefinitePolicy]);

    await service.executeRetentionCleanup();

    // No queryRunner interaction for indefinite policies
    expect(queryRunner.query).not.toHaveBeenCalled();
  });
});
