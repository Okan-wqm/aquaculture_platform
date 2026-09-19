/**
 * AiTriggerNatsHandler — MSGFIX-FAZ2 2.2 gate pins.
 *
 * Every gate is pinned independently:
 *   0. kill-switch OFF → no subscription, no processing
 *   1. AI's own messages (isAiResponse / AI_USER_ID sender) never re-trigger
 *   2. messageId idempotency claim — a second delivery of the same event is a no-op
 *   3. channel in-flight lock — a locked channel skips; the lock is released after
 *   4. daily ceiling — over the limit: ONE throttled notice, no dispatch
 *   plus: malformed ids dropped, non-AI channels dropped, empty content dropped,
 *   and the happy path dispatches AnalyzeMessageCommand with the fetched content.
 */
import { CommandBus } from '@nestjs/cqrs';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { createBaseEvent, MessageSentEvent } from '@platform/event-contracts';

import { AiTriggerNatsHandler } from '../ai-trigger-nats.handler';
import { AnalyzeMessageCommand } from '../commands/analyze-message.command';
import { AiChatBridgeService } from '../services/ai-chat-bridge.service';
import { AiTriggerConfig } from '../ai-trigger.config';
import { ChannelType, Channel } from '../../channel/entities/channel.entity';
import { AI_USER_ID } from '../../shared/ai-user';
import { createMockChannel, createMockMessage } from '../../__tests__/test-helpers';

const mockQueryRunner = {
  manager: {
    findOne: jest.fn(),
  },
};

jest.mock('@aquaculture/backend-common/database', () => {
  const actual = jest.requireActual('@aquaculture/backend-common/database');
  return {
    ...actual,
    runInTenantRead: jest.fn(
      (_ds: unknown, _schema: unknown, _tenant: unknown, fn: (qr: unknown) => unknown) =>
        Promise.resolve(fn(mockQueryRunner)),
    ),
  };
});

describe('AiTriggerNatsHandler (MSGFIX-FAZ2 2.2)', () => {
  let handler: AiTriggerNatsHandler;
  let triggerConfig: { triggerEnabled: boolean; channelDailyLimit: number };
  let commandBus: { execute: jest.Mock };
  let bridge: { persistThrottledNotice: jest.Mock };
  let redis: {
    set: jest.Mock;
    del: jest.Mock;
    incr: jest.Mock;
    expire: jest.Mock;
  };
  let eventBus: { subscribeWildcard: jest.Mock };

  // Valid lowercase-hex UUIDs (the handler's SEC-M17 guard rejects anything else).
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const channelId = '22222222-2222-4222-8222-222222222222';
  const messageId = '33333333-3333-4333-8333-333333333333';
  const senderId = '44444444-4444-4444-8444-444444444444';

  const messageSent = (overrides: Partial<MessageSentEvent> = {}): MessageSentEvent => {
    const event = {
      ...createBaseEvent('MessageSent', tenantId),
      messageId,
      channelId,
      senderId,
      contentType: 'text',
      hasAttachments: false,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
    // Single weak-type assertion: the literal covers every required member,
    // the generic-free shape satisfies the interface structurally.
    return event as MessageSentEvent;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockQueryRunner.manager.findOne.mockReset();

    triggerConfig = { triggerEnabled: true, channelDailyLimit: 50 };
    commandBus = { execute: jest.fn().mockResolvedValue(undefined) };
    bridge = { persistThrottledNotice: jest.fn().mockResolvedValue(undefined) };
    redis = {
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
    };
    eventBus = { subscribeWildcard: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiTriggerNatsHandler,
        { provide: AiTriggerConfig, useValue: triggerConfig },
        { provide: CommandBus, useValue: commandBus },
        { provide: AiChatBridgeService, useValue: bridge },
        { provide: DataSource, useValue: {} },
        { provide: 'REDIS_CLIENT', useValue: redis },
        { provide: 'EVENT_BUS', useValue: eventBus },
      ],
    }).compile();
    handler = module.get(AiTriggerNatsHandler);
  });

  const primeAiChannel = (opts: { content?: string | null } = {}) => {
    const channel = createMockChannel({ id: channelId, type: ChannelType.AI });
    const message = createMockMessage({
      id: messageId,
      channelId,
      senderId,
      content: opts.content ?? 'Hello AI',
    });
    mockQueryRunner.manager.findOne.mockImplementation(async (entity: unknown) => {
      if (entity === Channel) return channel;
      if (entity === Object) return null;
      return message;
    });
    return { channel, message };
  };

  // ── Gate 0: kill-switch ──────────────────────────────────────────────────

  it('does NOT subscribe while the kill-switch is OFF', async () => {
    triggerConfig.triggerEnabled = false;
    await handler.onModuleInit();
    expect(eventBus.subscribeWildcard).not.toHaveBeenCalled();
  });

  it('subscribes to MessageSent when the kill-switch is ON', async () => {
    await handler.onModuleInit();
    expect(eventBus.subscribeWildcard).toHaveBeenCalledWith('MessageSent', handler);
  });

  it('ignores events entirely when the switch flipped off after subscribe', async () => {
    triggerConfig.triggerEnabled = false;
    await handler.handle(messageSent());
    expect(redis.set).not.toHaveBeenCalled();
    expect(commandBus.execute).not.toHaveBeenCalled();
  });

  // ── Gate 1: self-trigger guard ───────────────────────────────────────────

  it('skips the AI service own reply (isAiResponse contract flag)', async () => {
    await handler.handle(messageSent({ senderId: AI_USER_ID, isAiResponse: true }));
    expect(redis.set).not.toHaveBeenCalled();
    expect(commandBus.execute).not.toHaveBeenCalled();
  });

  it('skips the AI sender id even when the legacy flag is absent', async () => {
    await handler.handle(messageSent({ senderId: AI_USER_ID }));
    expect(commandBus.execute).not.toHaveBeenCalled();
  });

  // ── Trust boundary ───────────────────────────────────────────────────────

  it('drops events with malformed ids before any Redis/DB use', async () => {
    await handler.handle(
      messageSent({ tenantId: 'not-a-uuid', channelId: 'x', messageId: '../../etc' }),
    );
    expect(redis.set).not.toHaveBeenCalled();
    expect(commandBus.execute).not.toHaveBeenCalled();
  });

  // ── Gate 2: messageId idempotency ────────────────────────────────────────

  it('processes a delivery only once (SETNX claim miss → skip)', async () => {
    primeAiChannel();
    redis.set.mockResolvedValue(null); // NX miss — already claimed

    await handler.handle(messageSent());

    expect(commandBus.execute).not.toHaveBeenCalled();
  });

  it('claims with key msg:ai-trigger:{tenantId}:{messageId} TTL 24h', async () => {
    primeAiChannel();
    await handler.handle(messageSent());

    const claimCall = redis.set.mock.calls.find((c) => String(c[0]).startsWith('msg:ai-trigger:'));
    expect(claimCall).toBeDefined();
    expect(claimCall?.[0]).toBe(`msg:ai-trigger:${tenantId}:${messageId}`);
    expect(claimCall?.[3]).toBe(24 * 60 * 60);
  });

  // ── Channel / content gating ─────────────────────────────────────────────

  it('skips non-AI channels without touching Redis counters or the command bus', async () => {
    const channel = createMockChannel({ id: channelId, type: ChannelType.GROUP });
    mockQueryRunner.manager.findOne.mockImplementation(async (entity: unknown) =>
      entity === Channel ? channel : createMockMessage({ content: 'hi' }),
    );

    await handler.handle(messageSent());

    expect(commandBus.execute).not.toHaveBeenCalled();
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('skips messages with empty content', async () => {
    primeAiChannel({ content: '   ' });
    await handler.handle(messageSent());
    expect(commandBus.execute).not.toHaveBeenCalled();
  });

  // ── Gate 4: daily ceiling ────────────────────────────────────────────────

  it('over the daily limit → ONE throttled bridge notice, no dispatch', async () => {
    primeAiChannel();
    redis.incr.mockResolvedValue(51); // limit 50

    await handler.handle(messageSent());

    expect(bridge.persistThrottledNotice).toHaveBeenCalledWith(
      tenantId,
      channelId,
      50,
      expect.stringMatching(/^\d{8}$/),
    );
    expect(commandBus.execute).not.toHaveBeenCalled();
  });

  it('daily counter failures fail closed (skip, no dispatch)', async () => {
    primeAiChannel();
    redis.incr.mockRejectedValue(new Error('redis down'));

    await handler.handle(messageSent());

    expect(commandBus.execute).not.toHaveBeenCalled();
    expect(bridge.persistThrottledNotice).not.toHaveBeenCalled();
  });

  // ── Gate 3: channel in-flight lock ───────────────────────────────────────

  it('skips when the channel lock is held; releases the lock after the turn', async () => {
    primeAiChannel();
    let callCount = 0;
    redis.set.mockImplementation(() => {
      // 1st set = trigger claim (OK); 2nd set = channel lock (simulate held)
      callCount += 1;
      return callCount === 1 ? 'OK' : null;
    });

    await handler.handle(messageSent());

    expect(commandBus.execute).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalledWith(`msg:ai-inflight:${channelId}`);
  });

  it('happy path: dispatches AnalyzeMessageCommand and releases the channel lock', async () => {
    primeAiChannel();

    await handler.handle(messageSent());

    expect(commandBus.execute).toHaveBeenCalledTimes(1);
    const command = commandBus.execute.mock.calls[0][0] as AnalyzeMessageCommand;
    expect(command).toBeInstanceOf(AnalyzeMessageCommand);
    expect(command.tenantId).toBe(tenantId);
    expect(command.channelId).toBe(channelId);
    expect(command.messageId).toBe(messageId);
    expect(command.content).toBe('Hello AI');
    expect(redis.del).toHaveBeenCalledWith(`msg:ai-inflight:${channelId}`);
  });
});
