import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SentimentAnalysisService } from '../sentiment-analysis.service';
import { AiPrivacyService } from '../ai-privacy.service';
import { MessageAnalysis } from '../../entities/message-analysis.entity';
import {
  createMockRepository,
  createMockNatsClient,
  fakeUuid,
  resetUuidCounter,
  MockRepository,
  MockNatsClient,
  TENANT_A,
} from '../../../__tests__/test-helpers';
import { of } from 'rxjs';

describe('SentimentAnalysisService', () => {
  let service: SentimentAnalysisService;
  let analysisRepo: MockRepository<MessageAnalysis>;
  let natsClient: MockNatsClient;
  let mockDataSource: { query: jest.Mock };
  let privacyService: jest.Mocked<Pick<AiPrivacyService, 'canAnalyzeMessage'>>;

  const channelId = fakeUuid('ch');
  const senderId = fakeUuid('usr');
  const messageId = fakeUuid('msg');
  const messageCreatedAt = new Date('2026-03-10T12:00:00Z');

  beforeEach(async () => {
    resetUuidCounter();

    analysisRepo = createMockRepository<MessageAnalysis>();
    natsClient = createMockNatsClient();
    mockDataSource = { query: jest.fn().mockResolvedValue([]) };
    privacyService = {
      canAnalyzeMessage: jest.fn().mockResolvedValue(true),
    };

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
      TENANT_A, channelId, messageId, messageCreatedAt, senderId, 'Great work!',
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
      TENANT_A, channelId, messageId, messageCreatedAt, senderId, 'Great work!',
    );

    expect(analysisRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
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
    mockDataSource.query.mockResolvedValueOnce([
      { score: '0.15' },
      { score: '0.20' },
      { score: '0.10' },
    ]);

    await service.analyzeMessage(
      TENANT_A, channelId, messageId, messageCreatedAt, senderId, 'This is terrible',
    );

    expect(natsClient.emit).toHaveBeenCalledWith(
      'events.SentimentAlert',
      expect.objectContaining({
        tenantId: TENANT_A,
        channelId,
        userId: senderId,
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Skips messages from non-consented users
  // -----------------------------------------------------------------------
  it('skips analysis when user has not consented', async () => {
    privacyService.canAnalyzeMessage.mockResolvedValue(false);

    await service.analyzeMessage(
      TENANT_A, channelId, messageId, messageCreatedAt, senderId, 'Hello',
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
        TENANT_A, channelId, messageId, messageCreatedAt, senderId, 'Hello',
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
    mockDataSource.query.mockResolvedValueOnce([
      { score: '0.15' },
      { score: '0.20' },
    ]);

    await service.analyzeMessage(
      TENANT_A, channelId, messageId, messageCreatedAt, senderId, 'Bad day',
    );

    expect(natsClient.emit).not.toHaveBeenCalled();
  });
});
