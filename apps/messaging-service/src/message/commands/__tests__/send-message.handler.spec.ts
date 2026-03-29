import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Message, MessageContentType } from '../../entities/message.entity';
import { MessageAttachment } from '../../entities/message-attachment.entity';
import { MessagingOutbox } from '../../../outbox/messaging-outbox.entity';
import { SendMessageHandler } from '../send-message.handler';
import { SendMessageCommand } from '../send-message.command';
import {
  createMockMessage,
  createMockRepository,
  createMockQueryRunner,
  createMockDataSource,
  createMockRedis,
  fakeUuid,
  resetUuidCounter,
  MockRepository,
  MockQueryRunner,
  MockRedis,
} from '../../../__tests__/test-helpers';

// Mock sanitize-html (may not have types installed)
jest.mock('sanitize-html', () => {
  return jest.fn((html: string) => html.replace(/<[^>]*>/g, ''));
});

/**
 * We mock the ioredis module so SendMessageHandler's constructor
 * creates our mock instance instead of a real connection.
 */
jest.mock('ioredis', () => {
  const mockRedis = {
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue('OK'),
    connect: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    status: 'ready',
  };
  return jest.fn(() => mockRedis);
});

// Import after mock
import Redis from 'ioredis';

describe('SendMessageHandler', () => {
  let handler: SendMessageHandler;
  let messageRepo: MockRepository<Message>;
  let attachmentRepo: MockRepository<MessageAttachment>;
  let queryRunner: MockQueryRunner;
  let mockDataSource: ReturnType<typeof createMockDataSource>;
  let redisInstance: Record<string, jest.Mock>;

  const tenantId = 'tenant-0001-0001-0001-000000000001';
  const channelId = fakeUuid('ch');
  const senderId = fakeUuid('usr');
  const idempotencyKey = fakeUuid('idem');

  beforeEach(async () => {
    resetUuidCounter();

    messageRepo = createMockRepository<Message>();
    attachmentRepo = createMockRepository<MessageAttachment>();
    queryRunner = createMockQueryRunner();
    mockDataSource = createMockDataSource(queryRunner);

    // Get the mock redis instance from the mocked constructor
    redisInstance = new Redis() as unknown as Record<string, jest.Mock>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SendMessageHandler,
        { provide: DataSource, useValue: mockDataSource },
        { provide: getRepositoryToken(Message), useValue: messageRepo },
        { provide: getRepositoryToken(MessageAttachment), useValue: attachmentRepo },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('localhost') } },
      ],
    }).compile();

    handler = module.get(SendMessageHandler);

    // Reset redis mocks for each test
    redisInstance['get'].mockReset().mockResolvedValue(null);
    redisInstance['setex'].mockReset().mockResolvedValue('OK');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function makeCmd(overrides: Partial<{
    content: string | null;
    contentType: MessageContentType;
    attachmentKeys: string[];
    metadata: Record<string, unknown> | null;
    parentId: string | null;
  }> = {}): SendMessageCommand {
    return new SendMessageCommand(
      tenantId,
      senderId,
      channelId,
      overrides.content ?? 'Hello',
      overrides.contentType ?? MessageContentType.TEXT,
      idempotencyKey,
      overrides.parentId ?? null,
      overrides.attachmentKeys ?? [],
      overrides.metadata ?? null,
    );
  }

  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------
  it('sends text message successfully', async () => {
    const cmd = makeCmd();

    const result = await handler.execute(cmd);

    expect(result).toBeDefined();
    expect(result.channelId).toBe(channelId);
    expect(result.senderId).toBe(senderId);
    // Message + outbox saved in transaction
    const saveCalls = queryRunner.manager.save.mock.calls;
    expect(saveCalls.length).toBeGreaterThanOrEqual(2);
  });

  // -----------------------------------------------------------------------
  // Idempotency
  // -----------------------------------------------------------------------
  it('returns existing message when same idempotencyKey (Redis hit)', async () => {
    const existingMsg = createMockMessage({ id: fakeUuid('msg'), channelId, senderId });
    redisInstance['get'].mockResolvedValue(existingMsg.id);
    messageRepo.findOne.mockResolvedValue(existingMsg);

    const cmd = makeCmd();
    const result = await handler.execute(cmd);

    expect(result.id).toBe(existingMsg.id);
    // Transaction should NOT be called
    expect(queryRunner.startTransaction).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // HTML sanitization
  // -----------------------------------------------------------------------
  it('sanitizes HTML from content (strips all tags)', async () => {
    const cmd = makeCmd({ content: 'Hello <script>alert("xss")</script> world' });

    const result = await handler.execute(cmd);

    // The saved content should not contain script tags
    const msgSaveCall = queryRunner.manager.save.mock.calls.find(
      (call) => call[0] === Message,
    );
    expect(msgSaveCall).toBeDefined();
    const savedContent = (msgSaveCall![1] as Partial<Message>).content;
    expect(savedContent).not.toContain('<script>');
    expect(savedContent).not.toContain('</script>');
  });

  it('strips javascript: URLs from content', async () => {
    const cmd = makeCmd({ content: 'Click javascript:alert(1)' });

    await handler.execute(cmd);

    const msgSaveCall = queryRunner.manager.save.mock.calls.find(
      (call) => call[0] === Message,
    );
    const savedContent = (msgSaveCall![1] as Partial<Message>).content;
    expect(savedContent).not.toContain('javascript:');
  });

  it('strips data: URLs from content', async () => {
    const cmd = makeCmd({ content: 'Image data:text/html,<script>alert(1)</script>' });

    await handler.execute(cmd);

    const msgSaveCall = queryRunner.manager.save.mock.calls.find(
      (call) => call[0] === Message,
    );
    const savedContent = (msgSaveCall![1] as Partial<Message>).content;
    expect(savedContent).not.toContain('data:');
  });

  it('allows http:// and https:// URLs', async () => {
    const cmd = makeCmd({ content: 'Visit https://example.com or http://example.com' });

    const result = await handler.execute(cmd);

    const msgSaveCall = queryRunner.manager.save.mock.calls.find(
      (call) => call[0] === Message,
    );
    const savedContent = (msgSaveCall![1] as Partial<Message>).content as string;
    expect(savedContent).toContain('https://example.com');
    expect(savedContent).toContain('http://example.com');
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------
  it('rejects empty content for TEXT messages', async () => {
    const cmd = makeCmd({ content: '' });

    await expect(handler.execute(cmd)).rejects.toThrow(BadRequestException);
  });

  // -----------------------------------------------------------------------
  // Transaction
  // -----------------------------------------------------------------------
  it('creates message and outbox event in same transaction', async () => {
    const cmd = makeCmd();

    await handler.execute(cmd);

    // Verify manager.save was called for both Message and MessagingOutbox
    const msgSave = queryRunner.manager.save.mock.calls.find((c) => c[0] === Message);
    const outboxSave = queryRunner.manager.save.mock.calls.find((c) => c[0] === MessagingOutbox);
    expect(msgSave).toBeDefined();
    expect(outboxSave).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Redis idempotency key set
  // -----------------------------------------------------------------------
  it('sets Redis idempotency key after successful send', async () => {
    const cmd = makeCmd();

    await handler.execute(cmd);

    expect(redisInstance['setex']).toHaveBeenCalled();
    const setexCall = redisInstance['setex'].mock.calls[0];
    expect(setexCall[0]).toContain(idempotencyKey);
    // TTL should be 7 days = 604800
    expect(setexCall[1]).toBe(604800);
  });

  // -----------------------------------------------------------------------
  // Redis failure graceful degradation
  // -----------------------------------------------------------------------
  it('handles Redis failure gracefully (still sends message)', async () => {
    redisInstance['get'].mockRejectedValue(new Error('Redis connection lost'));

    const cmd = makeCmd();
    const result = await handler.execute(cmd);

    // Message still created despite Redis failure
    expect(result).toBeDefined();
    expect(result.channelId).toBe(channelId);
  });

  // -----------------------------------------------------------------------
  // Attachments
  // -----------------------------------------------------------------------
  it('creates attachment records when attachmentKeys provided', async () => {
    const cmd = makeCmd({ attachmentKeys: ['uploads/doc.pdf', 'uploads/img.png'] });

    await handler.execute(cmd);

    const attSave = queryRunner.manager.save.mock.calls.find(
      (c) => c[0] === MessageAttachment,
    );
    expect(attSave).toBeDefined();
    const attachments = attSave![1] as Partial<MessageAttachment>[];
    expect(attachments).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // Outbox event content
  // -----------------------------------------------------------------------
  it('outbox event includes tenantId and channelId in payload', async () => {
    const cmd = makeCmd();

    await handler.execute(cmd);

    const outboxSave = queryRunner.manager.save.mock.calls.find(
      (c) => c[0] === MessagingOutbox,
    );
    const payload = (outboxSave![1] as Partial<MessagingOutbox>).payload as Record<string, unknown>;
    expect(payload.tenantId).toBe(tenantId);
    expect(payload.channelId).toBe(channelId);
  });
});
