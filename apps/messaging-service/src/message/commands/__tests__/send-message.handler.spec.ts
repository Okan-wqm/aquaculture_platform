// Mock sanitize-html (may not have type declarations)
jest.mock('sanitize-html', () => {
  return jest.fn((html: string) => html.replace(/<[^>]*>/g, ''));
}, { virtual: true });

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Message, MessageContentType } from '../../entities/message.entity';
import { MessageAttachment } from '../../entities/message-attachment.entity';
import { MessagingOutbox } from '../../../outbox/messaging-outbox.entity';
import { REDIS_CLIENT } from '../../../shared/redis.provider';
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

describe('SendMessageHandler', () => {
  let handler: SendMessageHandler;
  let messageRepo: MockRepository<Message>;
  let attachmentRepo: MockRepository<MessageAttachment>;
  let queryRunner: MockQueryRunner;
  let mockDataSource: ReturnType<typeof createMockDataSource>;
  let redisClient: MockRedis;

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
    redisClient = createMockRedis();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SendMessageHandler,
        { provide: DataSource, useValue: mockDataSource },
        { provide: getRepositoryToken(Message), useValue: messageRepo },
        { provide: getRepositoryToken(MessageAttachment), useValue: attachmentRepo },
        { provide: REDIS_CLIENT, useValue: redisClient },
      ],
    }).compile();

    handler = module.get(SendMessageHandler);
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
    redisClient.get.mockResolvedValue(null);
    const cmd = makeCmd();

    const result = await handler.execute(cmd);

    expect(result).toBeDefined();
    expect(result.channelId).toBe(channelId);
    expect(result.senderId).toBe(senderId);
  });

  // -----------------------------------------------------------------------
  // Idempotency
  // -----------------------------------------------------------------------
  it('returns existing message when same idempotencyKey (Redis hit)', async () => {
    const existingMsg = createMockMessage({ id: fakeUuid('msg'), channelId, senderId });
    redisClient.get.mockResolvedValue(existingMsg.id);
    messageRepo.findOne.mockResolvedValue(existingMsg);

    const cmd = makeCmd();
    const result = await handler.execute(cmd);

    expect(result.id).toBe(existingMsg.id);
    // No transaction when idempotency hit
    expect(mockDataSource.transaction).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // HTML sanitization
  // -----------------------------------------------------------------------
  it('sanitizes HTML from content (strips all tags)', async () => {
    redisClient.get.mockResolvedValue(null);
    const cmd = makeCmd({ content: 'Hello <script>alert("xss")</script> world' });

    const result = await handler.execute(cmd);

    // The saved content should not contain script tags
    const msgSaveCall = queryRunner.manager.save.mock.calls.find(
      (call) => call[0] === Message,
    );
    expect(msgSaveCall).toBeDefined();
    const savedContent = (msgSaveCall![1] as Partial<Message>).content;
    expect(savedContent).not.toContain('<script>');
  });

  it('strips javascript: URLs from content', async () => {
    redisClient.get.mockResolvedValue(null);
    const cmd = makeCmd({ content: 'Click javascript:alert(1)' });

    await handler.execute(cmd);

    const msgSaveCall = queryRunner.manager.save.mock.calls.find(
      (call) => call[0] === Message,
    );
    const savedContent = (msgSaveCall![1] as Partial<Message>).content;
    expect(savedContent).not.toContain('javascript:');
  });

  it('strips data: URLs from content', async () => {
    redisClient.get.mockResolvedValue(null);
    const cmd = makeCmd({ content: 'Image data:text/html,<script>alert(1)</script>' });

    await handler.execute(cmd);

    const msgSaveCall = queryRunner.manager.save.mock.calls.find(
      (call) => call[0] === Message,
    );
    const savedContent = (msgSaveCall![1] as Partial<Message>).content;
    expect(savedContent).not.toContain('data:');
  });

  it('allows http:// and https:// URLs', async () => {
    redisClient.get.mockResolvedValue(null);
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
    redisClient.get.mockResolvedValue(null);
    const cmd = makeCmd({ content: '' });

    await expect(handler.execute(cmd)).rejects.toThrow(BadRequestException);
  });

  // -----------------------------------------------------------------------
  // Transaction
  // -----------------------------------------------------------------------
  it('creates message and outbox event in same transaction', async () => {
    redisClient.get.mockResolvedValue(null);
    const cmd = makeCmd();

    await handler.execute(cmd);

    // manager.save called for Message and MessagingOutbox inside transaction
    const msgSave = queryRunner.manager.save.mock.calls.find((c) => c[0] === Message);
    const outboxSave = queryRunner.manager.save.mock.calls.find((c) => c[0] === MessagingOutbox);
    expect(msgSave).toBeDefined();
    expect(outboxSave).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Redis idempotency key set
  // -----------------------------------------------------------------------
  it('sets Redis idempotency key after successful send', async () => {
    redisClient.get.mockResolvedValue(null);
    const cmd = makeCmd();

    await handler.execute(cmd);

    expect(redisClient.setex).toHaveBeenCalled();
    const setexCall = redisClient.setex.mock.calls[0];
    expect(setexCall[0]).toContain(idempotencyKey);
    // TTL should be 7 days = 604800
    expect(setexCall[1]).toBe(604800);
  });

  // -----------------------------------------------------------------------
  // Redis failure graceful degradation
  // -----------------------------------------------------------------------
  it('handles Redis failure gracefully (still sends message)', async () => {
    redisClient.get.mockRejectedValue(new Error('Redis connection lost'));
    const cmd = makeCmd();

    const result = await handler.execute(cmd);

    expect(result).toBeDefined();
    expect(result.channelId).toBe(channelId);
  });

  // -----------------------------------------------------------------------
  // Attachments
  // -----------------------------------------------------------------------
  it('creates attachment records when attachmentKeys provided', async () => {
    redisClient.get.mockResolvedValue(null);
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
    redisClient.get.mockResolvedValue(null);
    const cmd = makeCmd();

    await handler.execute(cmd);

    const outboxSave = queryRunner.manager.save.mock.calls.find(
      (c) => c[0] === MessagingOutbox,
    );
    const outboxData = outboxSave![1] as Partial<MessagingOutbox>;
    const payload = outboxData.payload as Record<string, unknown>;
    expect(payload.tenantId).toBe(tenantId);
    expect(payload.channelId).toBe(channelId);
  });
});
