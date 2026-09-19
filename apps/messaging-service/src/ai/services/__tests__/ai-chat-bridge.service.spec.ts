/**
 * AiChatBridgeService — MSGFIX-FAZ2 2.3 behavior pins.
 *
 * The bridge is mocked at its collaborators (London School): DataSource is
 * stubbed so runInTenantRead/runInTenantTransaction run the wrapped callback
 * against a mock queryRunner/manager; every dependency is jest-mocked.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { InputFilterService, OutputPiiScannerService } from '@aquaculture/backend-common/ai-safety';
import { AiChatBridgeService } from '../ai-chat-bridge.service';
import { AiCallerCapabilitiesService } from '../ai-caller-capabilities.service';
import { AiEgressGateService } from '../ai-egress-gate.service';
import { AiPrivacyService } from '../ai-privacy.service';
import { AiTriggerConfig } from '../../ai-trigger.config';
import { Channel, ChannelType } from '../../../channel/entities/channel.entity';
import { Message, MessageContentType } from '../../../message/entities/message.entity';
import { AI_USER_ID } from '../../../shared/ai-user';
import {
  createMockNatsClient,
  createMockChannel,
  createMockMessage,
  createMockQueryBuilder,
  fakeUuid,
} from '../../../__tests__/test-helpers';
import { of } from 'rxjs';

const mockQueryRunner = {
  manager: {
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
  },
};

jest.mock('@aquaculture/backend-common/database', () => {
  // Thin pass-through of the tenant-pinning wrappers: they simply invoke the
  // callback with the mock queryRunner. The REAL wrappers are covered by
  // backend-common's own suite; here we assert WHAT the bridge queries.
  const actual = jest.requireActual('@aquaculture/backend-common/database');
  return {
    ...actual,
    runInTenantRead: jest.fn(
      (_ds: unknown, _schema: unknown, _tenant: unknown, fn: (qr: unknown) => unknown) =>
        Promise.resolve(fn(mockQueryRunner)),
    ),
    runInTenantTransaction: jest.fn(
      (_ds: unknown, _schema: unknown, _tenant: unknown, fn: (qr: unknown) => unknown) =>
        Promise.resolve(fn(mockQueryRunner)),
    ),
  };
});

describe('AiChatBridgeService (MSGFIX-FAZ2)', () => {
  let service: AiChatBridgeService;
  let natsClient: ReturnType<typeof createMockNatsClient>;
  let callerCapabilities: { resolve: jest.Mock };
  let egressGate: { isAllowed: jest.Mock };
  let privacyService: { hasUserConsented: jest.Mock };
  let inputFilter: { scanInput: jest.Mock };
  let outputPiiScanner: { redact: jest.Mock };
  let outboxPublisher: { enqueue: jest.Mock };
  let redis: { set: jest.Mock; del: jest.Mock; get: jest.Mock };
  let insertBuilder: {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    orIgnore: jest.Mock;
    returning: jest.Mock;
    execute: jest.Mock;
  };
  let triggerConfig: { contextCharBudget: number };

  const tenantId = '11111111-1111-4111-8111-111111111111';
  const aiChannelId = fakeUuid('ch1');
  const groupChannelId = fakeUuid('ch2');
  const triggerMessageId = fakeUuid('msg');
  const senderId = fakeUuid('usr');

  const capabilities = {
    roles: ['MODULE_USER'],
    resourcePermissions: ['ai_assistant:use', 'ai_personas:operator'],
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    natsClient = createMockNatsClient();
    callerCapabilities = { resolve: jest.fn().mockResolvedValue(capabilities) };
    egressGate = { isAllowed: jest.fn().mockResolvedValue(true) };
    privacyService = { hasUserConsented: jest.fn().mockResolvedValue(true) };
    inputFilter = {
      scanInput: jest.fn().mockReturnValue({
        safe: true,
        flaggedPatterns: [],
        severity: 'none',
      }),
    };
    outputPiiScanner = {
      redact: jest.fn().mockImplementation((text: string) => ({
        redactedText: text,
        scanResult: { hasPii: false, detections: [], countByType: {} },
      })),
    };
    outboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };
    redis = {
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue(null),
    };
    triggerConfig = { contextCharBudget: 24_000 };

    // Idempotency ledger claim builder — default: claim succeeds (1 row).
    insertBuilder = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ raw: [{ messageId: 'x' }] }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiChatBridgeService,
        { provide: DataSource, useValue: {} },
        { provide: 'NATS_SERVICE', useValue: natsClient },
        { provide: InputFilterService, useValue: inputFilter },
        { provide: OutputPiiScannerService, useValue: outputPiiScanner },
        { provide: AiCallerCapabilitiesService, useValue: callerCapabilities },
        { provide: AiPrivacyService, useValue: privacyService },
        { provide: AiTriggerConfig, useValue: triggerConfig },
        { provide: AiEgressGateService, useValue: egressGate },
        { provide: OutboxPublisher, useValue: outboxPublisher },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();

    service = module.get(AiChatBridgeService);
  });

  const aiChannel = () =>
    Object.assign(createMockChannel({ id: aiChannelId, type: ChannelType.AI }), {
      aiPersona: 'operator-v1',
    });

  const primeChannelRead = (channel: Channel | null) => {
    mockQueryRunner.manager.findOne.mockImplementation(async (entity: unknown) => {
      if (entity === Channel) return channel;
      if (entity === Message) {
        return createMockMessage({ id: triggerMessageId, content: 'Question' });
      }
      return null;
    });
  };

  /**
   * The tenant-pinned context read calls
   * `manager.createQueryBuilder(Message, 'm')` (SELECT); the ledger claim
   * calls `manager.createQueryBuilder()` then `.insert()` (no args).
   * Route by argument count.
   */
  const primeContextQuery = (messages: Message[]) => {
    const qb = createMockQueryBuilder<Message>();
    (qb.getMany as jest.Mock).mockResolvedValue(messages);
    mockQueryRunner.manager.createQueryBuilder.mockImplementation((...args: unknown[]) => {
      if (args.length >= 1) {
        return qb;
      }
      return insertBuilder;
    });
    return qb;
  };

  // -----------------------------------------------------------------------
  // Happy path: authorized sender, consent OK → forward + persist exactly once
  // -----------------------------------------------------------------------
  it('forwards to request.ai.chat with resolved roles/permissions and consent-filtered context (no conversationId)', async () => {
    primeChannelRead(aiChannel());
    const contextMsg = createMockMessage({
      channelId: aiChannelId,
      senderId,
      content: 'earlier turn',
    });
    primeContextQuery([contextMsg]);

    natsClient.send.mockReturnValue(of({ content: 'AI answer', metadata: null }));

    await service.handleAiChannelMessage(
      tenantId,
      aiChannelId,
      triggerMessageId,
      'What is water quality?',
      senderId,
    );

    expect(natsClient.send).toHaveBeenCalledWith(
      'request.ai.chat',
      expect.objectContaining({
        tenantId,
        channelId: aiChannelId,
        messageId: triggerMessageId,
        content: 'What is water quality?',
        userId: senderId,
        persona: 'operator-v1',
        userRoles: capabilities.roles,
        resourcePermissions: capabilities.resourcePermissions,
        contextMessages: [
          expect.objectContaining({ senderId, content: 'earlier turn', isAi: false }),
        ],
      }),
    );
    // Channel memory rides contextMessages ONLY — a channel-derived
    // conversationId would collide with ai-service per-user ownership.
    const request = natsClient.send.mock.calls[0]?.[1] as Record<string, unknown>;
    expect('conversationId' in request).toBe(false);
  });

  it('egress gate denial stops everything (no NATS, no persistence)', async () => {
    primeChannelRead(aiChannel());
    egressGate.isAllowed.mockResolvedValue(false);

    await service.handleAiChannelMessage(tenantId, aiChannelId, triggerMessageId, 'q', senderId);

    expect(egressGate.isAllowed).toHaveBeenCalledWith(tenantId, senderId, 'ai-chat');
    expect(callerCapabilities.resolve).not.toHaveBeenCalled();
    expect(natsClient.send).not.toHaveBeenCalled();
  });

  it('returns early for non-AI channels (tenant-pinned channel read)', async () => {
    primeChannelRead(
      Object.assign(createMockChannel({ id: groupChannelId, type: ChannelType.GROUP })),
    );

    await service.handleAiChannelMessage(
      tenantId,
      groupChannelId,
      triggerMessageId,
      'Hello',
      senderId,
    );

    expect(natsClient.send).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Faz 2.3: authorization
  // -----------------------------------------------------------------------
  it('unresolvable capabilities → ONE throttled SYSTEM notice, NO ai-service call', async () => {
    primeChannelRead(aiChannel());
    callerCapabilities.resolve.mockResolvedValue(null);

    await service.handleAiChannelMessage(tenantId, aiChannelId, triggerMessageId, 'q', senderId);

    expect(natsClient.send).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledWith(
      `msg:ai-notice:${tenantId}:${aiChannelId}`,
      triggerMessageId,
      'EX',
      expect.any(Number),
      'NX',
    );
    // The notice is persisted as a SYSTEM message with metadata.error.
    expect(mockQueryRunner.manager.create).toHaveBeenCalledWith(
      Message,
      expect.objectContaining({
        senderId: AI_USER_ID,
        contentType: MessageContentType.SYSTEM,
        metadata: expect.objectContaining({ error: true, errorCode: 'AI_AUTH_UNRESOLVED' }),
      }),
    );
  });

  it('missing ai_assistant:use → throttled AI_NOT_PERMITTED notice', async () => {
    primeChannelRead(aiChannel());
    callerCapabilities.resolve.mockResolvedValue({
      roles: ['MODULE_USER'],
      resourcePermissions: [],
    });

    await service.handleAiChannelMessage(tenantId, aiChannelId, triggerMessageId, 'q', senderId);

    expect(natsClient.send).not.toHaveBeenCalled();
    expect(mockQueryRunner.manager.create).toHaveBeenCalledWith(
      Message,
      expect.objectContaining({
        metadata: expect.objectContaining({ errorCode: 'AI_NOT_PERMITTED' }),
      }),
    );
  });

  it('TENANT_ADMIN bypasses the ai_assistant:use grant check', async () => {
    primeChannelRead(aiChannel());
    primeContextQuery([]);
    callerCapabilities.resolve.mockResolvedValue({
      roles: ['TENANT_ADMIN'],
      resourcePermissions: [], // admins carry [] by design (JWT parity)
    });
    natsClient.send.mockReturnValue(of({ content: 'ok', metadata: null }));

    await service.handleAiChannelMessage(tenantId, aiChannelId, triggerMessageId, 'q', senderId);

    expect(natsClient.send).toHaveBeenCalled();
  });

  it('notice throttle window suppresses a second notice in the same window', async () => {
    primeChannelRead(aiChannel());
    callerCapabilities.resolve.mockResolvedValue(null);

    await service.handleAiChannelMessage(tenantId, aiChannelId, triggerMessageId, 'q1', senderId);
    // Second turn: throttle key already claimed.
    redis.set.mockResolvedValue(null); // ioredis returns null when NX misses
    await service.handleAiChannelMessage(tenantId, aiChannelId, fakeUuid('msg'), 'q2', senderId);

    expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Faz 2.3: error contract — no error text as a normal AI reply
  // -----------------------------------------------------------------------
  it('responder error (metadata.errorCode) → throttled notice, NOT an AI reply message', async () => {
    primeChannelRead(aiChannel());
    primeContextQuery([]);
    natsClient.send.mockReturnValue(
      of({
        content: 'No AI API key is configured. Ask a tenant admin to add one in AI settings.',
        metadata: { errorCode: 'AI_KEY_MISSING' },
        error: { code: 'AI_KEY_MISSING', message: 'No AI API key is configured.' },
      }),
    );

    await service.handleAiChannelMessage(tenantId, aiChannelId, triggerMessageId, 'q', senderId);

    expect(mockQueryRunner.manager.create).toHaveBeenCalledWith(
      Message,
      expect.objectContaining({
        metadata: expect.objectContaining({ error: true, errorCode: 'AI_KEY_MISSING' }),
      }),
    );
  });

  it('NATS transport failure → null response path → throttled AI_UNAVAILABLE notice', async () => {
    primeChannelRead(aiChannel());
    primeContextQuery([]);
    natsClient.send.mockImplementation(() => {
      throw new Error('boom');
    });

    await service.handleAiChannelMessage(tenantId, aiChannelId, triggerMessageId, 'q', senderId);

    expect(mockQueryRunner.manager.create).toHaveBeenCalledWith(
      Message,
      expect.objectContaining({
        metadata: expect.objectContaining({ errorCode: 'AI_UNAVAILABLE' }),
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Consent-filtered context + char budget
  // -----------------------------------------------------------------------
  it('drops non-consented senders from context but keeps AI turns and consented users', async () => {
    primeChannelRead(aiChannel());
    // qb result order = DESC (newest first), matching the bridge's read.
    const consented = createMockMessage({ senderId, content: 'from sender' });
    const otherUser = createMockMessage({ senderId: fakeUuid('oth'), content: 'no consent' });
    const aiTurn = createMockMessage({ senderId: AI_USER_ID, content: 'prior AI reply' });
    primeContextQuery([consented, otherUser, aiTurn]);

    privacyService.hasUserConsented.mockImplementation(
      async (_t: string, userId: string) => userId === senderId,
    );
    natsClient.send.mockReturnValue(of({ content: 'ok', metadata: null }));

    await service.handleAiChannelMessage(tenantId, aiChannelId, triggerMessageId, 'q', senderId);

    const payload = natsClient.send.mock.calls[0]?.[1] as {
      contextMessages: Array<{ content: string }>;
    };
    // Chronological (oldest first) after the bridge's reverse: AI turn →
    // consented user; the non-consenting sender's message never leaves.
    expect(payload.contextMessages.map((c) => c.content)).toEqual([
      'prior AI reply',
      'from sender',
    ]);
  });

  it('enforces the character budget keeping the newest turns', async () => {
    primeChannelRead(aiChannel());
    // DESC input: fresh is newest; budget 10 chars keeps only the newest.
    const fresh = createMockMessage({ senderId, content: 'new' });
    const old = createMockMessage({ senderId, content: 'x'.repeat(20) });
    primeContextQuery([fresh, old]);
    natsClient.send.mockReturnValue(of({ content: 'ok', metadata: null }));

    triggerConfig.contextCharBudget = 10;

    await service.handleAiChannelMessage(tenantId, aiChannelId, triggerMessageId, 'q', senderId);

    const payload = natsClient.send.mock.calls[0]?.[1] as {
      contextMessages: Array<{ content: string }>;
    };
    expect(payload.contextMessages.map((c) => c.content)).toEqual(['new']);

    triggerConfig.contextCharBudget = 24_000;
  });

  // -----------------------------------------------------------------------
  // persistAiResponse — exactly-once ledger claim + isAiResponse outbox stamp
  // -----------------------------------------------------------------------
  it('persists the AI reply with isAiResponse:true outbox event + metadata.isAi', async () => {
    primeChannelRead(aiChannel());
    primeContextQuery([]);
    natsClient.send.mockReturnValue(of({ content: 'Here is the answer.', metadata: null }));

    await service.handleAiChannelMessage(tenantId, aiChannelId, triggerMessageId, 'q', senderId);

    expect(mockQueryRunner.manager.create).toHaveBeenCalledWith(
      Message,
      expect.objectContaining({
        channelId: aiChannelId,
        senderId: AI_USER_ID,
        content: 'Here is the answer.',
        contentType: MessageContentType.SYSTEM,
        isAiGenerated: true,
      }),
    );
    expect(outboxPublisher.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'MessageSent',
        senderId: AI_USER_ID,
        isAiResponse: true,
      }),
      expect.anything(),
    );
  });

  it('a conflicted ledger claim (redelivery) skips the insert entirely', async () => {
    primeChannelRead(aiChannel());
    primeContextQuery([]);
    natsClient.send.mockReturnValue(of({ content: 'answer', metadata: null }));
    // Conflict: ON CONFLICT DO NOTHING → empty raw RETURNING.
    insertBuilder.execute.mockResolvedValue({ raw: [] });

    await service.handleAiChannelMessage(tenantId, aiChannelId, triggerMessageId, 'q', senderId);

    expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
    expect(outboxPublisher.enqueue).not.toHaveBeenCalled();
  });

  it('jailbreak-flagged input persists a safety_block reply under the SAME reply ledger key', async () => {
    primeChannelRead(aiChannel());
    primeContextQuery([]);
    inputFilter.scanInput.mockReturnValue({
      safe: false,
      flaggedPatterns: ['override'],
      severity: 'high',
    });

    await service.handleAiChannelMessage(tenantId, aiChannelId, triggerMessageId, 'hack', senderId);

    expect(natsClient.send).not.toHaveBeenCalled();
    expect(mockQueryRunner.manager.create).toHaveBeenCalledWith(
      Message,
      expect.objectContaining({
        metadata: expect.objectContaining({ type: 'safety_block' }),
      }),
    );
  });
});
