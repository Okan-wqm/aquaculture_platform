import { Test, TestingModule } from '@nestjs/testing';
import { ComplianceAuditService } from '../compliance-audit.service';
import {
  ComplianceAuditLog,
  ComplianceAction,
} from '../../entities/compliance-audit-log.entity';
import {
  createMockRepository,
  createMockQueryBuilder,
  createMockAuditEntry,
  fakeUuid,
  resetUuidCounter,
  MockRepository,
} from '../../../__tests__/test-helpers';
import { DataSource } from 'typeorm';
import type { SelectQueryBuilder } from 'typeorm';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('ComplianceAuditService', () => {
  let service: ComplianceAuditService;
  let auditRepo: MockRepository<ComplianceAuditLog>;
  let dataSource: jest.Mocked<Pick<DataSource, 'createQueryRunner'>>;
  let queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    query: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    manager: {
      getRepository: jest.Mock;
    };
  };

  const userId = fakeUuid('usr');

  beforeEach(async () => {
    resetUuidCounter();

    auditRepo = createMockRepository<ComplianceAuditLog>();

    auditRepo.create.mockImplementation(
      (data: unknown) => data as ComplianceAuditLog,
    );
    auditRepo.save.mockImplementation(
      (data: unknown) => Promise.resolve(data as ComplianceAuditLog),
    );
    queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager: {
        getRepository: jest.fn().mockReturnValue(auditRepo),
      },
    };
    dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    } as jest.Mocked<Pick<DataSource, 'createQueryRunner'>>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ComplianceAuditService,
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(ComplianceAuditService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Logs message_send action
  // -----------------------------------------------------------------------
  it('logs a message_send action', async () => {
    await service.log({
      tenantId: TENANT_A,
      userId,
      action: ComplianceAction.MESSAGE_SEND,
      resourceType: 'message',
      resourceId: fakeUuid('msg'),
      details: { channelId: fakeUuid('ch') },
      ipAddress: '10.0.0.1',
      userAgent: 'TestAgent/1.0',
    });

    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_A,
        action: ComplianceAction.MESSAGE_SEND,
      }),
    );
    expect(auditRepo.save).toHaveBeenCalled();
    expect(queryRunner.query).toHaveBeenCalledWith(
      `SELECT pg_catalog.set_config('search_path', $1, true)`,
      ['"tenant_aaaaaaaaaaaa4aaa", "messaging", public'],
    );
  });

  // -----------------------------------------------------------------------
  // Logs message_delete action
  // -----------------------------------------------------------------------
  it('logs a message_delete action', async () => {
    await service.log({
      tenantId: TENANT_A,
      userId,
      action: ComplianceAction.MESSAGE_DELETE,
      resourceType: 'message',
      resourceId: fakeUuid('msg'),
      details: null,
      ipAddress: null,
      userAgent: null,
    });

    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: ComplianceAction.MESSAGE_DELETE,
      }),
    );
    expect(auditRepo.save).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Logs data_anonymize action
  // -----------------------------------------------------------------------
  it('logs a data_anonymize action', async () => {
    await service.log({
      tenantId: TENANT_A,
      userId,
      action: ComplianceAction.DATA_ANONYMIZE,
      resourceType: 'user',
      resourceId: userId,
      details: { reason: 'GDPR request' },
      ipAddress: '10.0.0.1',
      userAgent: null,
    });

    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: ComplianceAction.DATA_ANONYMIZE,
        details: { reason: 'GDPR request' },
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Logs retention_set action
  // -----------------------------------------------------------------------
  it('logs a retention_set action', async () => {
    await service.log({
      tenantId: TENANT_A,
      userId,
      action: ComplianceAction.RETENTION_SET,
      resourceType: 'retention_policy',
      resourceId: fakeUuid('rp'),
      details: { retentionDays: 90 },
      ipAddress: null,
      userAgent: null,
    });

    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: ComplianceAction.RETENTION_SET,
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Paginated query with filters
  // -----------------------------------------------------------------------
  it('supports paginated query with action filter', async () => {
    const entry1 = createMockAuditEntry({
      action: ComplianceAction.MESSAGE_SEND,
      createdAt: new Date('2026-03-10T12:00:00Z'),
    });
    const entry2 = createMockAuditEntry({
      action: ComplianceAction.MESSAGE_SEND,
      createdAt: new Date('2026-03-10T11:00:00Z'),
    });

    const qb = createMockQueryBuilder<ComplianceAuditLog>();
    (qb.getMany as jest.Mock).mockResolvedValue([entry1, entry2]);
    // For totalCount
    const countQb = createMockQueryBuilder<ComplianceAuditLog>();
    (countQb.getCount as jest.Mock).mockResolvedValue(2);

    auditRepo.createQueryBuilder
      .mockReturnValueOnce(qb as unknown as SelectQueryBuilder<ComplianceAuditLog>)
      .mockReturnValueOnce(countQb as unknown as SelectQueryBuilder<ComplianceAuditLog>);

    const page = await service.getAuditLog(
      { tenantId: TENANT_A, action: ComplianceAction.MESSAGE_SEND },
      10,
      null,
    );

    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(false);
    expect(page.totalCount).toBe(2);
    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('action'),
      expect.objectContaining({ action: ComplianceAction.MESSAGE_SEND }),
    );
  });

  // -----------------------------------------------------------------------
  // Fire-and-forget safe — errors do not propagate
  // -----------------------------------------------------------------------
  it('does not throw when audit log write fails', async () => {
    auditRepo.save.mockRejectedValue(new Error('DB connection lost'));

    await expect(
      service.log({
        tenantId: TENANT_A,
        userId,
        action: ComplianceAction.MESSAGE_SEND,
        resourceType: 'message',
        resourceId: fakeUuid('msg'),
        details: null,
        ipAddress: null,
        userAgent: null,
      }),
    ).resolves.not.toThrow();
  });

  // -----------------------------------------------------------------------
  // Batch insert
  // -----------------------------------------------------------------------
  it('supports batch insert of multiple audit entries', async () => {
    const entries = [
      {
        tenantId: TENANT_A,
        userId,
        action: ComplianceAction.MESSAGE_SEND,
        resourceType: 'message',
        resourceId: fakeUuid('msg'),
        details: null,
        ipAddress: null,
        userAgent: null,
      },
      {
        tenantId: TENANT_A,
        userId,
        action: ComplianceAction.MESSAGE_DELETE,
        resourceType: 'message',
        resourceId: fakeUuid('msg'),
        details: null,
        ipAddress: null,
        userAgent: null,
      },
    ];

    await service.logBatch(entries);

    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ action: ComplianceAction.MESSAGE_SEND }),
        expect.objectContaining({ action: ComplianceAction.MESSAGE_DELETE }),
      ]),
    );
    expect(auditRepo.save).toHaveBeenCalled();
  });
});
