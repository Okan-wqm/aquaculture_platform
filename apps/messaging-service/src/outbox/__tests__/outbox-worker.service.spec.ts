import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MessagingOutbox } from '../messaging-outbox.entity';
import { OutboxWorkerService } from '../outbox-worker.service';
import {
  createMockOutboxEvent,
  createMockRepository,
  createMockNatsClient,
  fakeUuid,
  resetUuidCounter,
  MockRepository,
  MockNatsClient,
} from '../../__tests__/test-helpers';
import { of, throwError } from 'rxjs';

describe('OutboxWorkerService', () => {
  let service: OutboxWorkerService;
  let outboxRepo: MockRepository<MessagingOutbox>;
  let natsClient: MockNatsClient;

  beforeEach(async () => {
    resetUuidCounter();

    outboxRepo = createMockRepository<MessagingOutbox>();
    natsClient = createMockNatsClient();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxWorkerService,
        { provide: getRepositoryToken(MessagingOutbox), useValue: outboxRepo },
        { provide: 'NATS_SERVICE', useValue: natsClient },
      ],
    }).compile();

    service = module.get(OutboxWorkerService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Publish pending events
  // -----------------------------------------------------------------------
  it('publishes pending events to NATS', async () => {
    const event = createMockOutboxEvent({
      id: '1',
      eventType: 'MessageSent',
      payload: { channelId: fakeUuid('ch'), messageId: fakeUuid('msg') },
      publishedAt: null,
    });
    outboxRepo.find.mockResolvedValue([event]);

    await service.pollAndPublish();

    expect(natsClient.emit).toHaveBeenCalledWith(
      `events.MessageSent`,
      expect.objectContaining({ channelId: expect.any(String) }),
    );
  });

  // -----------------------------------------------------------------------
  // Sets publishedAt on success
  // -----------------------------------------------------------------------
  it('sets publishedAt on successful publish', async () => {
    const event = createMockOutboxEvent({ id: '1', publishedAt: null });
    outboxRepo.find.mockResolvedValue([event]);

    await service.pollAndPublish();

    expect(outboxRepo.update).toHaveBeenCalled();
    const updateArgs = outboxRepo.update.mock.calls[0];
    expect(updateArgs[0]).toBe('1'); // event id
    expect(updateArgs[1]).toHaveProperty('publishedAt');
    expect((updateArgs[1] as Record<string, unknown>).publishedAt).toBeInstanceOf(Date);
  });

  // -----------------------------------------------------------------------
  // Retry on failure
  // -----------------------------------------------------------------------
  it('increments retryCount on failure', async () => {
    const event = createMockOutboxEvent({ id: '2', retryCount: 1, publishedAt: null });
    outboxRepo.find.mockResolvedValue([event]);

    // Make NATS emit throw
    natsClient.emit.mockReturnValue(throwError(() => new Error('NATS unavailable')));

    await service.pollAndPublish();

    expect(outboxRepo.update).toHaveBeenCalled();
    const updateArgs = outboxRepo.update.mock.calls[0];
    expect((updateArgs[1] as Record<string, unknown>).retryCount).toBe(2);
  });

  it('sets lastError on failure', async () => {
    const event = createMockOutboxEvent({ id: '3', publishedAt: null });
    outboxRepo.find.mockResolvedValue([event]);

    natsClient.emit.mockReturnValue(throwError(() => new Error('Connection refused')));

    await service.pollAndPublish();

    const updateArgs = outboxRepo.update.mock.calls[0];
    expect((updateArgs[1] as Record<string, unknown>).lastError).toContain('Connection refused');
  });

  // -----------------------------------------------------------------------
  // Max retries
  // -----------------------------------------------------------------------
  it('stops retrying after MAX_RETRIES (5) -- dead letters', async () => {
    const event = createMockOutboxEvent({
      id: '4',
      retryCount: 5,
      publishedAt: null,
    });
    outboxRepo.find.mockResolvedValue([event]);

    await service.pollAndPublish();

    // Should NOT attempt to emit for exhausted events
    expect(natsClient.emit).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Order (createdAt ASC)
  // -----------------------------------------------------------------------
  it('processes events in creation order (ASC)', async () => {
    outboxRepo.find.mockResolvedValue([]);

    await service.pollAndPublish();

    const findCall = outboxRepo.find.mock.calls[0][0] as Record<string, unknown>;
    expect(findCall).toBeDefined();
    const orderOption = findCall?.order as Record<string, string>;
    expect(orderOption.createdAt).toBe('ASC');
  });

  // -----------------------------------------------------------------------
  // Batch size
  // -----------------------------------------------------------------------
  it('respects batch size limit (100)', async () => {
    outboxRepo.find.mockResolvedValue([]);

    await service.pollAndPublish();

    const findCall = outboxRepo.find.mock.calls[0][0] as Record<string, unknown>;
    expect(findCall.take).toBe(100);
  });
});
