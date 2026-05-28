import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { SentimentAnalysisService } from '../sentiment-analysis.service';
import { AiPrivacyService } from '../ai-privacy.service';
import { MessageAnalysis } from '../../entities/message-analysis.entity';
import {
  createMockRepository,
  createMockDataSource,
  createMockNatsClient,
  createMockQueryRunner,
  fakeUuid,
  resetUuidCounter,
  MockRepository,
  MockNatsClient,
  MockQueryRunner,
} from '../../../__tests__/test-helpers';
import { of } from 'rxjs';

describe('SentimentAnalysisService', () => {
  let service: SentimentAnalysisService;
  let analysisRepo: MockRepository<MessageAnalysis>;
  let natsClient: MockNatsClient;
  let queryRunner: MockQueryRunner;
  let mockDataSource: ReturnType<typeof createMockDataSource>;
  let privacyService: jest.Mocked<Pick<AiPrivacyService, 'canAnalyzeMessage'>>;
  let outboxPublisher: { enqueue: jest.Mock };

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const channelId = fakeUuid('ch');
  const senderId = fakeUuid('usr');
  const messageId = fakeUuid('msg');
  const messageCreatedAt = new Date('2026-03-10T12:00:00Z');

  beforeEach(async () => {
    resetUuidCounter();

    analysisRepo = createMockRepository<MessageAnalysis>();
    natsClient = createMockNatsClient();
    queryRunner = createMockQueryRunner();
    mockDataSource = createMockDataSource(queryRunner);
    privacyService = {
      canAnalyzeMessage: jest.fn().mockResolvedValue(true),
    };
    outboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };

    // analysisRepo.create returns the input as-is
    analysisRepo.create.mockImplementation(
      (data: unknown) => data as MessageAnalysis,
    );
    analysisRepo.save.mockImplementation(
      (data: unknown) => Promise.resolve(data as MessageAnalysis),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SentimentAnalysisService,
        { provide: getRepositoryToken(MessageAnalysis), useValue: analysisRepo },
        { provide: DataSource, useValue: mockDataSource },
        { provide: 'NATS_SERVICE', useValue: natsClient },
        { provide: AiPrivacyService, useValue: privacyService },
        { provide: OutboxPublisher, useValue: outboxPublisher },
      ],
    }).compile();

    service = module.get(SentimentAnalysisService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Analyzes message sentiment via NATS request to ai-service
  // -----------------------------------------------------------------------
  it('sends sentiment analysis request to ai-service via NATS', async () => {
    const sentimentResponse = { label: 'POSITIVE' as const, score: 0.92, confidence: 0.88 };
    natsClient.send.mockReturnValue(of(sentimentResponse));

    await service.analyzeMessage(
      tenantId, channelId, messageId, messageCreatedAt, senderId, 'Great work!',
    );

    expect(natsClient.send).toHaveBeenCalledWith(
      'request.ai.analyzeSentiment',
      { text: 'Great work!' },
    );
  });

  // -----------------------------------------------------------------------
  // Stores result in message_analysis table
  // -----------------------------------------------------------------------
  it('stores sentiment result in message_analysis table', async () => {
    const sentimentResponse = { label: 'POSITIVE' as const, score: 0.92, confidence: 0.88 };
    natsClient.send.mockReturnValue(of(sentimentResponse));

    await service.analyzeMessage(
      tenantId, channelId, messageId, messageCreatedAt, senderId, 'Great work!',
    );

    expect(analysisRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        messageId,
        messageCreatedAt,
        analysisType: 'sentiment',
        result: sentimentResponse,
        modelVersion: 'distilbert-sst2-v1.0',
      }),
    );
    expect(analysisRepo.save).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Triggers SentimentAlert when 3+ consecutive negative messages
  // -----------------------------------------------------------------------
  it('emits SentimentAlert event when 3+ consecutive negative messages detected', async () => {
    const negativeResponse = { label: 'NEGATIVE' as const, score: 0.15, confidence: 0.90 };
    natsClient.send.mockReturnValue(of(negativeResponse));

    // Mock DB query returning 3 consecutive negative analyses
    queryRunner.manager.query.mockResolvedValueOnce([
      { score: '0.15' },
      { score: '0.20' },
      { score: '0.10' },
    ]);

    await service.analyzeMessage(
      tenantId, channelId, messageId, messageCreatedAt, senderId, 'This is terrible',
    );

    expect(outboxPublisher.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        eventType: 'SentimentAlert',
        channelId,
        userId: senderId,
      }),
      queryRunner.manager,
    );
  });

  // -----------------------------------------------------------------------
  // Skips messages from non-consented users
  // -----------------------------------------------------------------------
  it('skips analysis when user has not consented', async () => {
    privacyService.canAnalyzeMessage.mockResolvedValue(false);

    await service.analyzeMessage(
      tenantId, channelId, messageId, messageCreatedAt, senderId, 'Hello',
    );

    expect(natsClient.send).not.toHaveBeenCalled();
    expect(analysisRepo.save).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Handles ai-service timeout gracefully
  // -----------------------------------------------------------------------
  it('handles ai-service timeout without crashing', async () => {
    // NATS send returns null (caught by catchError in service)
    natsClient.send.mockReturnValue(of(null));

    await expect(
        service.analyzeMessage(
        tenantId, channelId, messageId, messageCreatedAt, senderId, 'Hello',
      ),
    ).resolves.not.toThrow();

    // No analysis should be saved when response is null
    expect(analysisRepo.save).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Does not trigger alert when fewer than 3 negative messages
  // -----------------------------------------------------------------------
  it('does not trigger alert when fewer than 3 consecutive negatives', async () => {
    const negativeResponse = { label: 'NEGATIVE' as const, score: 0.15, confidence: 0.90 };
    natsClient.send.mockReturnValue(of(negativeResponse));

    // Only 2 negative analyses
    queryRunner.manager.query.mockResolvedValueOnce([
      { score: '0.15' },
      { score: '0.20' },
    ]);

    await service.analyzeMessage(
      tenantId, channelId, messageId, messageCreatedAt, senderId, 'Bad day',
    );

    expect(outboxPublisher.enqueue).not.toHaveBeenCalled();
  });
});
