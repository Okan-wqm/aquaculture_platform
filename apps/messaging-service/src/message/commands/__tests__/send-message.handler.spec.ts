// Mock sanitize-html (may not have type declarations)
jest.mock('sanitize-html', () => {
  return jest.fn((html: string) => html.replace(/<[^>]*>/g, ''));
}, { virtual: true });

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { Message, MessageContentType } from '../../entities/message.entity';
import { MessageSendIdempotency } from '../../entities/message-send-idempotency.entity';
import { MessageAttachment } from '../../entities/message-attachment.entity';
import { ChannelMember } from '../../../channel/entities/channel-member.entity';
// MessagingOutbox import dropped: outbox writes go through
// OutboxPublisher.enqueue, not direct manager.save(MessagingOutbox).
// The test seam is now the publisher mock itself.
import { REDIS_CLIENT } from '../../../shared/redis.provider';
import { MentionService } from '../../services/mention.service';
import { MediaService } from '../../services/media.service';
import { MediaFinalizationService } from '../../services/media-finalization.service';
import { MessagingMetricsService } from '../../../metrics/messaging-metrics.service';
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

// PROC-MEDIUM-009 closed by PR-40. Original PR-28 placeholder (`describe.skip`)
// preserved test bodies pending DI rebuild. This rewrite registers all 9
// constructor providers (was 4) so jest can actually run the 12 cases:
//   - ChannelMember repo (for mention-resolution lookup)
//   - MentionService.parseMentions (returns processedContent + mentionedUserIds)
//   - MediaService.validateAttachmentKey + extractVoiceDuration
//   - MessagingMetricsService.incrementMessages (Prometheus counter)
//   - OutboxPublisher.enqueue (transactional outbox INSERT)
describe('SendMessageHandler', () => {
  let handler: SendMessageHandler;
  let messageRepo: MockRepository<Message>;
  let attachmentRepo: MockRepository<MessageAttachment>;
  let channelMemberRepo: MockRepository<ChannelMember>;
  let queryRunner: MockQueryRunner;
  let mockDataSource: ReturnType<typeof createMockDataSource>;
  let redisClient: MockRedis;
  // Service mocks — declared at the suite scope so individual tests
  // can re-stub specific methods via `mentionService.parseMentions.mockReturnValueOnce(...)`.
  let mentionService: { parseMentions: jest.Mock };
  let mediaService: {
    validateAttachmentKey: jest.Mock;
    extractVoiceDuration: jest.Mock;
    isAudioMimeType: jest.Mock;
  };
  let mediaFinalizationService: { finalizeAttachment: jest.Mock };
  let metricsService: { incrementMessages: jest.Mock };
  let outboxPublisher: { enqueue: jest.Mock };
  let ledgerInsertBuilder: {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    orIgnore: jest.Mock;
    returning: jest.Mock;
    execute: jest.Mock;
  };

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const channelId = fakeUuid('ch');
  const senderId = fakeUuid('usr');
  const idempotencyKey = fakeUuid('idem');

  beforeEach(async () => {
    resetUuidCounter();

    messageRepo = createMockRepository<Message>();
    attachmentRepo = createMockRepository<MessageAttachment>();
    channelMemberRepo = createMockRepository<ChannelMember>();
    // The handler calls channelMemberRepo.find(...) inside the mention-
    // resolution path (line ~101). Default to an empty array so the
    // .map() at line 109 works for tests that don't seed members
    // explicitly. Tests that exercise mention behaviour override.
    channelMemberRepo.find.mockResolvedValue([]);
    queryRunner = createMockQueryRunner();
    queryRunner.manager.find.mockResolvedValue([]);
    // Ledger-claim fluent builder (cluster-8 DİLİM-1): every send now
    // claims message_send_idempotency via INSERT ... ON CONFLICT DO
    // NOTHING at transaction start. Default: claim SUCCEEDS (fresh send).
    // Duplicate-path tests override execute() with empty identifiers.
    ledgerInsertBuilder = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ identifiers: [{}], raw: [{}], generatedMaps: [] }),
    };
    queryRunner.manager.createQueryBuilder.mockReturnValue(ledgerInsertBuilder);
    mockDataSource = createMockDataSource(queryRunner);
    redisClient = createMockRedis();

    mentionService = {
      // Default: pass content through unchanged with no mention IDs.
      // The handler uses processedContent as the final sanitizedContent
      // (see send-message.handler.ts:118), so returning '' would make
      // every TEXT-message test fail the non-empty content guard.
      parseMentions: jest.fn().mockImplementation(
        (content: string) => ({ mentionedUserIds: [], processedContent: content }),
      ),
    };
    mediaService = {
      // Default: every attachment key validates as image/png 1024 bytes.
      // Tests that need a specific shape override via mockResolvedValueOnce.
      validateAttachmentKey: jest.fn().mockResolvedValue({
        contentLength: 1024,
        contentType: 'image/png',
      }),
      extractVoiceDuration: jest.fn().mockReturnValue(null),
      isAudioMimeType: jest.fn((mime: string) => mime.toLowerCase().startsWith('audio/')),
    };
    // MSG-HIGH-056 / MSG-MEDIUM-056: finalization runs pre-transaction. Default:
    // each attachment finalizes to dimensions 100x80, a thumb key, and whatever
    // duration was passed (null for images, the voice duration for audio).
    mediaFinalizationService = {
      finalizeAttachment: jest.fn(
        async (storageKey: string, _mimeType: string, durationSeconds: number | null) => ({
          width: 100,
          height: 80,
          durationSeconds,
          thumbnailKey: `${storageKey}_thumb`,
        }),
      ),
    };
    metricsService = { incrementMessages: jest.fn() };
    // Outbox enqueue is fire-and-await inside the transaction — return
    // void to mirror the real OutboxPublisher.
    outboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SendMessageHandler,
        { provide: DataSource, useValue: mockDataSource },
        { provide: getRepositoryToken(Message), useValue: messageRepo },
        { provide: getRepositoryToken(MessageAttachment), useValue: attachmentRepo },
        { provide: getRepositoryToken(ChannelMember), useValue: channelMemberRepo },
        { provide: REDIS_CLIENT, useValue: redisClient },
        { provide: MentionService, useValue: mentionService },
        { provide: MediaService, useValue: mediaService },
        { provide: MediaFinalizationService, useValue: mediaFinalizationService },
        { provide: MessagingMetricsService, useValue: metricsService },
        { provide: OutboxPublisher, useValue: outboxPublisher },
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
    // The handler now uses SET-NX: if Redis returns null (key already
    // exists), the handler treats it as an idempotent hit. The previous
    // implementation did GET-first; the rewrite is race-safe (atomic SET-NX).
    redisClient.set.mockResolvedValue(null);
    redisClient.get.mockResolvedValue(existingMsg.id);
    queryRunner.manager.findOne.mockResolvedValue(existingMsg);

    const cmd = makeCmd();
    const result = await handler.execute(cmd);

    expect(result.id).toBe(existingMsg.id);
    expect(queryRunner.query).toHaveBeenCalledWith(
      `SELECT pg_catalog.set_config('search_path', $1, true)`,
      ['"tenant_aaaaaaaaaaaa4aaa", "messaging", public'],
    );
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

    // Message save goes through the transaction's manager directly.
    const msgSave = queryRunner.manager.save.mock.calls.find((c) => c[0] === Message);
    expect(msgSave).toBeDefined();
    // The outbox row is now written via OutboxPublisher.enqueue(event, manager)
    // — a thin wrapper that calls manager.save(OutboxEntityClass, …) inside
    // the same transaction. Asserting on the publisher mock is the
    // architecturally correct seam: it verifies the transactional
    // outbox contract without coupling the test to the publisher's
    // internal save implementation. The `manager` arg proves the
    // enqueue ran INSIDE the transaction (same EntityManager
    // instance the message save used).
    expect(outboxPublisher.enqueue).toHaveBeenCalledTimes(1);
    const [, enqueueManager] = outboxPublisher.enqueue.mock.calls[0]!;
    expect(enqueueManager).toBe(queryRunner.manager);
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
  // MSG-HIGH-056: finalized media columns are persisted (no longer dead)
  // -----------------------------------------------------------------------
  it('persists finalized width/height/thumbnailKey onto each attachment row', async () => {
    redisClient.get.mockResolvedValue(null);
    const cmd = makeCmd({ attachmentKeys: ['uploads/img.png'] });

    await handler.execute(cmd);

    // Finalization ran for the attachment BEFORE the transaction.
    expect(mediaFinalizationService.finalizeAttachment).toHaveBeenCalledWith(
      'uploads/img.png',
      'image/png',
      null,
    );

    const attSave = queryRunner.manager.save.mock.calls.find(
      (c) => c[0] === MessageAttachment,
    );
    const attachments = attSave![1] as Partial<MessageAttachment>[];
    expect(attachments[0]).toMatchObject({
      width: 100,
      height: 80,
      thumbnailKey: 'uploads/img.png_thumb',
    });
  });

  // -----------------------------------------------------------------------
  // MSG-HIGH-055: voice duration is written to attachment.durationSeconds,
  // NOT stuffed into message metadata under the old server-only key.
  // -----------------------------------------------------------------------
  it('writes voice duration to attachment.durationSeconds (not message metadata)', async () => {
    redisClient.get.mockResolvedValue(null);
    // Audio attachment + extracted duration.
    mediaService.validateAttachmentKey.mockResolvedValue({
      contentLength: 2048,
      contentType: 'audio/webm',
    });
    mediaService.extractVoiceDuration.mockReturnValue(12.34);

    const cmd = makeCmd({
      content: null,
      contentType: MessageContentType.VOICE,
      attachmentKeys: ['uploads/voice.webm'],
      metadata: { durationSeconds: 12.34 },
    });

    await handler.execute(cmd);

    // The audio attachment carried the duration into finalization...
    expect(mediaFinalizationService.finalizeAttachment).toHaveBeenCalledWith(
      'uploads/voice.webm',
      'audio/webm',
      12.34,
    );

    // ...and onto the persisted attachment row's typed column.
    const attSave = queryRunner.manager.save.mock.calls.find(
      (c) => c[0] === MessageAttachment,
    );
    const attachments = attSave![1] as Partial<MessageAttachment>[];
    expect(attachments[0]?.durationSeconds).toBe(12.34);

    // The message metadata must NOT carry the old server-only voiceDurationSeconds key.
    const msgSave = queryRunner.manager.save.mock.calls.find((c) => c[0] === Message);
    const savedMessage = msgSave![1] as Partial<Message>;
    const metadata = savedMessage.metadata as Record<string, unknown> | null;
    if (metadata) {
      expect(metadata).not.toHaveProperty('voiceDurationSeconds');
    }
  });

  // -----------------------------------------------------------------------
  // Outbox event content
  // -----------------------------------------------------------------------
  it('outbox event includes tenantId and channelId in payload', async () => {
    redisClient.get.mockResolvedValue(null);
    const cmd = makeCmd();

    await handler.execute(cmd);

    // The outbox row is written via OutboxPublisher.enqueue(event, manager)
    // — assert directly on the FIRST argument the publisher received.
    // The event is BaseEvent (from createBaseEvent) plus domain-specific
    // fields the handler spreads alongside (channelId / messageId /
    // senderId / etc., see send-message.handler.ts:200-209). Strict-tsc
    // rejects a direct `as Record<string, unknown>` cast on IEvent
    // because IEvent has no index signature; narrow via `unknown` to a
    // structural type that captures only the fields this test asserts on.
    expect(outboxPublisher.enqueue).toHaveBeenCalledTimes(1);
    const [enqueuedEvent] = outboxPublisher.enqueue.mock.calls[0]!;
    const payload = enqueuedEvent as unknown as {
      tenantId?: string;
      channelId?: string;
      eventType?: string;
    };
    expect(payload.eventType).toBe('MessageSent');
    expect(payload.tenantId).toBe(tenantId);
    expect(payload.channelId).toBe(channelId);
  });

  // ── Cluster-8 DİLİM-1: authoritative DB idempotency ledger ──────────
  describe('idempotency ledger (message_send_idempotency)', () => {
    function makeCommand(): SendMessageCommand {
      return new SendMessageCommand(
        tenantId,
        senderId,
        channelId,
        'hello',
        MessageContentType.TEXT,
        idempotencyKey,
        null,
        [],
        null,
      );
    }

    it('returns the original message when the ledger claim conflicts (no new insert, no metric)', async () => {
      const existing = createMockMessage({ tenantId, channelId, senderId });
      const ledgerRow = {
        tenantId,
        channelId,
        senderId,
        idempotencyKey,
        messageId: existing.id,
        messageCreatedAt: existing.createdAt,
      };
      ledgerInsertBuilder.execute.mockResolvedValue({ identifiers: [{}], raw: [], generatedMaps: [] });
      queryRunner.manager.findOne.mockImplementation(
        (entity: unknown) =>
          Promise.resolve(entity === MessageSendIdempotency ? ledgerRow : existing),
      );

      const result = await handler.execute(makeCommand());

      expect(result).toBe(existing);
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
      expect(outboxPublisher.enqueue).not.toHaveBeenCalled();
      expect(metricsService.incrementMessages).not.toHaveBeenCalled();
    });

    it('stays idempotent with Redis fully down — the ledger claim is the authority', async () => {
      // Both safe* wrappers swallow Redis failures (fail-open cache);
      // the DB claim must still run and gate the send.
      redisClient.set.mockRejectedValue(new Error('redis down'));
      redisClient.get.mockRejectedValue(new Error('redis down'));
      redisClient.setex.mockRejectedValue(new Error('redis down'));

      const result = await handler.execute(makeCommand());

      expect(result).toBeDefined();
      expect(ledgerInsertBuilder.execute).toHaveBeenCalledTimes(1);
      expect(ledgerInsertBuilder.orIgnore).toHaveBeenCalledTimes(1);
    });

    it('fails loud when the claim conflicts but the ledger row is unreadable', async () => {
      // identifiers stay non-empty on conflict (TypeORM fabricates them
      // from VALUES for non-generated PKs) — raw is the truth signal.
      ledgerInsertBuilder.execute.mockResolvedValue({ identifiers: [{}], raw: [], generatedMaps: [] });
      queryRunner.manager.findOne.mockResolvedValue(null);

      await expect(handler.execute(makeCommand())).rejects.toThrow(ConflictException);
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
    });
  });
});
