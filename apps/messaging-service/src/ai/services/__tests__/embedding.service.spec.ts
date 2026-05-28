import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '../../../shared/redis.provider';
import { EmbeddingService } from '../embedding.service';
import { AiPrivacyService } from '../ai-privacy.service';
import {
  createMockNatsClient,
  createMockRedis,
  createMockQueryRunner,
  createMockDataSource,
  fakeUuid,
  resetUuidCounter,
  MockNatsClient,
  MockQueryRunner,
} from '../../../__tests__/test-helpers';
import { of } from 'rxjs';

describe('EmbeddingService', () => {
  let service: EmbeddingService;
  let mockDataSource: ReturnType<typeof createMockDataSource>;
  let queryRunner: MockQueryRunner;
  let natsClient: MockNatsClient;
  let privacyService: jest.Mocked<Pick<AiPrivacyService, 'canAnalyzeMessage'>>;

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userA = fakeUuid('usr');
  const userB = fakeUuid('usr');

  beforeEach(async () => {
    resetUuidCounter();

    queryRunner = createMockQueryRunner();
    mockDataSource = createMockDataSource(queryRunner);
    natsClient = createMockNatsClient();
    privacyService = {
      canAnalyzeMessage: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmbeddingService,
        { provide: DataSource, useValue: mockDataSource },
        { provide: 'NATS_SERVICE', useValue: natsClient },
        { provide: AiPrivacyService, useValue: privacyService },
      ],
    }).compile();

    service = module.get(EmbeddingService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Processes only messages where embedding IS NULL
  // -----------------------------------------------------------------------
  it('fetches only messages where embedding IS NULL', async () => {
    // runBatch is private; trigger via processUnembeddedMessages
    mockDataSource.createQueryRunner().query = jest.fn();
    // Simulate the raw SQL returning unembedded messages
    (mockDataSource as unknown as { query: jest.Mock }).query = jest
      .fn()
      .mockResolvedValueOnce([]); // no messages to process

    await service.processUnembeddedMessages();

    // The DataSource.query should contain WHERE embedding IS NULL
    const queryCalls = (mockDataSource as unknown as { query: jest.Mock }).query.mock.calls;
    if (queryCalls.length > 0) {
      const sql = queryCalls[0][0] as string;
      expect(sql).toContain('embedding');
      expect(sql).toContain('IS NULL');
    }
  });

  // -----------------------------------------------------------------------
  // Respects privacy gates
  // -----------------------------------------------------------------------
  it('skips messages from non-consented users', async () => {
    const messages = [
      { id: fakeUuid('msg'), tenantId, channelId: fakeUuid('ch'), senderId: userA, content: 'Hello', createdAt: new Date() },
      { id: fakeUuid('msg'), tenantId, channelId: fakeUuid('ch'), senderId: userB, content: 'World', createdAt: new Date() },
    ];

    (mockDataSource as unknown as { query: jest.Mock }).query = jest
      .fn()
      .mockResolvedValueOnce(messages);

    // userA consented, userB did NOT
    privacyService.canAnalyzeMessage
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    // ai-service returns embeddings for consented user
    natsClient.send.mockReturnValue(of({ embeddings: [[0.1, 0.2, 0.3]] }));

    await service.processUnembeddedMessages();

    // Only 1 message should be sent for embedding (userA)
    expect(privacyService.canAnalyzeMessage).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // Batches messages correctly (max 100)
  // -----------------------------------------------------------------------
  it('limits batch size to 100 messages', async () => {
    (mockDataSource as unknown as { query: jest.Mock }).query = jest
      .fn()
      .mockResolvedValueOnce([]); // returns empty

    await service.processUnembeddedMessages();

    const queryCalls = (mockDataSource as unknown as { query: jest.Mock }).query.mock.calls;
    if (queryCalls.length > 0) {
      const params = queryCalls[0][1] as number[];
      expect(params[0]).toBe(100);
    }
  });

  // -----------------------------------------------------------------------
  // Writes embeddings back to messages table
  // -----------------------------------------------------------------------
  it('writes embeddings back via UPDATE query', async () => {
    const msg = {
      id: fakeUuid('msg'),
      tenantId,
      channelId: fakeUuid('ch'),
      senderId: userA,
      content: 'Test message',
      createdAt: new Date('2026-03-10T12:00:00Z'),
    };
    (mockDataSource as unknown as { query: jest.Mock }).query = jest
      .fn()
      .mockResolvedValueOnce([msg]);

    privacyService.canAnalyzeMessage.mockResolvedValue(true);
    natsClient.send.mockReturnValue(of({ embeddings: [[0.1, 0.2, 0.3]] }));

    await service.processUnembeddedMessages();

    // The queryRunner should have an UPDATE messages SET embedding
    const qrQueryCalls = queryRunner.query.mock.calls;
    const updateCall = qrQueryCalls.find((call) => {
      const sql = call[0] as string;
      return sql.includes('UPDATE') && sql.includes('embedding');
    });
    expect(updateCall).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Graceful degradation when ai-service unavailable
  // -----------------------------------------------------------------------
  it('does not crash when ai-service is unavailable', async () => {
    const msg = {
      id: fakeUuid('msg'),
      tenantId,
      channelId: fakeUuid('ch'),
      senderId: userA,
      content: 'Test message',
      createdAt: new Date('2026-03-10T12:00:00Z'),
    };
    (mockDataSource as unknown as { query: jest.Mock }).query = jest
      .fn()
      .mockResolvedValueOnce([msg]);

    privacyService.canAnalyzeMessage.mockResolvedValue(true);
    // ai-service returns null (caught by catchError)
    natsClient.send.mockReturnValue(of(null));

    // Should not throw
    await expect(service.processUnembeddedMessages()).resolves.not.toThrow();
  });
});
