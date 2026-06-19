import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DataExportService } from '../data-export.service';
import { LegalHoldService } from '../legal-hold.service';
import { ComplianceAuditService } from '../compliance-audit.service';
import { Message } from '../../../message/entities/message.entity';
import {
  createMockRepository,
  createMockMessage,
  createMockAttachment,
  createMockDataSource,
  createMockQueryRunner,
  fakeUuid,
  resetUuidCounter,
  MockRepository,
  MockQueryRunner,
} from '../../../__tests__/test-helpers';

describe('DataExportService', () => {
  let service: DataExportService;
  let messageRepo: MockRepository<Message>;
  let legalHoldService: jest.Mocked<Pick<LegalHoldService, 'isUnderLegalHold'>>;
  let auditService: jest.Mocked<Pick<ComplianceAuditService, 'log'>>;
  let mockQueryRunner: MockQueryRunner;
  let mockDataSource: ReturnType<typeof createMockDataSource>;

  const channelId = fakeUuid('ch');
  const userId = fakeUuid('usr');
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  beforeEach(async () => {
    resetUuidCounter();

    messageRepo = createMockRepository<Message>();
    legalHoldService = { isUnderLegalHold: jest.fn().mockResolvedValue(false) };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    // The service opens a QueryRunner transaction for tenant routing
    // (cross-service / cron contexts), then connects / queries / releases it.
    // The current createMockDataSource API takes a MockQueryRunner and exposes
    // createQueryRunner() returning it, so the spec must supply both.
    mockQueryRunner = createMockQueryRunner();
    mockDataSource = createMockDataSource(mockQueryRunner);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataExportService,
        { provide: DataSource, useValue: mockDataSource },
        { provide: getRepositoryToken(Message), useValue: messageRepo },
        { provide: LegalHoldService, useValue: legalHoldService },
        { provide: ComplianceAuditService, useValue: auditService },
      ],
    }).compile();

    service = module.get(DataExportService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Exports channel history as JSON
  // -----------------------------------------------------------------------
  it('exports channel history as JSON', async () => {
    const messages = [
      createMockMessage({
        channelId,
        content: 'Hello',
        attachments: [createMockAttachment({ originalFilename: 'doc.pdf' })],
      }),
      createMockMessage({ channelId, content: 'World', attachments: [] }),
    ];
    mockQueryRunner.manager.find
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(messages);

    const result = await service.exportChannel(tenantId, channelId, 'json', userId);

    expect(result.format).toBe('json');
    expect(result.recordCount).toBe(2);

    const parsed = JSON.parse(result.data) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toHaveProperty('messageId');
    expect(parsed[0]).toHaveProperty('content', 'Hello');
    expect(parsed[0]).toHaveProperty('attachmentCount', 1);
  });

  // -----------------------------------------------------------------------
  // Exports channel history as CSV
  // -----------------------------------------------------------------------
  it('exports channel history as CSV', async () => {
    const messages = [
      createMockMessage({ channelId, content: 'Hello', attachments: [] }),
    ];
    mockQueryRunner.manager.find
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(messages);

    const result = await service.exportChannel(tenantId, channelId, 'csv', userId);

    expect(result.format).toBe('csv');
    const lines = result.data.split('\n');
    // First line = headers
    expect(lines[0]).toContain('messageId');
    expect(lines[0]).toContain('content');
    // Second line = data
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  // -----------------------------------------------------------------------
  // Includes messages, attachment metadata
  // -----------------------------------------------------------------------
  it('includes attachment metadata in export', async () => {
    const attachment = createMockAttachment({
      originalFilename: 'report.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileSize: 2048,
    });
    const messages = [
      createMockMessage({ channelId, attachments: [attachment] }),
    ];
    mockQueryRunner.manager.find
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(messages);

    const result = await service.exportChannel(tenantId, channelId, 'json', userId);
    const parsed = JSON.parse(result.data) as Array<Record<string, unknown>>;

    expect(parsed[0]).toHaveProperty('attachmentCount', 1);
  });

  // -----------------------------------------------------------------------
  // Marks legal hold data appropriately
  // -----------------------------------------------------------------------
  it('marks messages with legal hold flag when channel is under hold', async () => {
    const messages = [
      createMockMessage({ channelId, content: 'Held message', attachments: [] }),
    ];
    mockQueryRunner.manager.find
      .mockResolvedValueOnce([{ tenantId, channelId, isActive: true, expiresAt: null }])
      .mockResolvedValueOnce(messages);

    const result = await service.exportChannel(tenantId, channelId, 'json', userId);
    const parsed = JSON.parse(result.data) as Array<Record<string, unknown>>;

    expect(parsed[0]).toHaveProperty('hasLegalHold', true);
    expect(result.isUnderLegalHold).toBe(true);
  });

  it('marks hasLegalHold=false when no hold is active', async () => {
    const messages = [
      createMockMessage({ channelId, content: 'Normal message', attachments: [] }),
    ];
    mockQueryRunner.manager.find
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(messages);

    const result = await service.exportChannel(tenantId, channelId, 'json', userId);
    const parsed = JSON.parse(result.data) as Array<Record<string, unknown>>;

    expect(parsed[0]).toHaveProperty('hasLegalHold', false);
    expect(result.isUnderLegalHold).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Logs export to compliance audit
  // -----------------------------------------------------------------------
  it('logs the export operation to the compliance audit', async () => {
    mockQueryRunner.manager.find
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await service.exportChannel(tenantId, channelId, 'json', userId);

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        userId,
        action: 'message_export',
        resourceType: 'channel',
        resourceId: channelId,
        details: expect.objectContaining({
          format: 'json',
          recordCount: 0,
        }),
      }),
    );
  });
});
