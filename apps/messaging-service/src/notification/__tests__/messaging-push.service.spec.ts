/**
 * @module MessagingPushService Tests
 * @description Unit tests for push notification dispatch logic.
 * Validates sender skip, presence check, notification preferences,
 * @mention override, and deduplication.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { MessagingPushService } from '../messaging-push.service';
import { ChannelMember, NotificationPreference } from '../../channel/entities/channel-member.entity';
import { PresenceService } from '../../presence/presence.service';
import { REDIS_CLIENT } from '../../shared/redis.provider';
import { Message } from '../../message/entities/message.entity';
import {
  createMockDataSource,
  createMockQueryBuilder,
  createMockQueryRunner,
  createMockRedis,
  MockQueryRunner,
} from '../../__tests__/test-helpers';

describe('MessagingPushService', () => {
  let service: MessagingPushService;
  let queryRunner: MockQueryRunner;
  let mockDataSource: ReturnType<typeof createMockDataSource>;

  const mockPresenceService = {
    getOnlineUsers: jest.fn(),
  };

  const mockEventBus = {
    publish: jest.fn().mockResolvedValue(undefined),
  };

  let mockRedis: ReturnType<typeof createMockRedis>;

  const basePayload = {
    eventId: 'evt-1',
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    channelId: 'channel-1',
    messageId: 'msg-1',
    senderId: 'user-sender',
    contentType: 'TEXT',
    hasAttachments: false,
    createdAt: new Date().toISOString(),
    senderDisplayName: 'Alice',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    queryRunner = createMockQueryRunner();
    mockDataSource = createMockDataSource(queryRunner);
    mockRedis = createMockRedis();

    const unreadQuery = createMockQueryBuilder<Message>();
    unreadQuery.getCount.mockResolvedValue(3);
    queryRunner.manager.createQueryBuilder.mockReturnValue(unreadQuery);
    queryRunner.manager.findOne.mockResolvedValue({
      userId: 'recipient',
      notificationPreference: NotificationPreference.ALL,
      lastReadAt: null,
    } as ChannelMember);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingPushService,
        { provide: DataSource, useValue: mockDataSource },
        { provide: PresenceService, useValue: mockPresenceService },
        { provide: 'EVENT_BUS', useValue: mockEventBus },
        { provide: REDIS_CLIENT, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<MessagingPushService>(MessagingPushService);
  });

  it('should send push notifications to offline members', async () => {
    queryRunner.manager.find.mockResolvedValue([
      { userId: 'user-sender', notificationPreference: NotificationPreference.ALL },
      { userId: 'user-a', notificationPreference: NotificationPreference.ALL },
      { userId: 'user-b', notificationPreference: NotificationPreference.ALL },
    ]);
    mockPresenceService.getOnlineUsers.mockResolvedValue(
      new Map([['user-a', false], ['user-b', false]]),
    );

    await service.handleMessageSent(basePayload);

    expect(mockEventBus.publish).toHaveBeenCalledTimes(2);
    expect(mockEventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ChatPushRequested',
        tenantId: basePayload.tenantId,
        recipientUserId: 'user-a',
        notificationRef: expect.any(String),
        badge: 3,
        notificationType: 'CHAT_MESSAGE',
      }),
    );
    expect(mockRedis.setex).toHaveBeenCalledWith(
      expect.stringContaining(`msg:push:ref:${basePayload.tenantId}:`),
      900,
      expect.stringContaining('"recipientUserId":"user-a"'),
    );
  });

  it('should skip the message sender', async () => {
    queryRunner.manager.find.mockResolvedValue([
      { userId: 'user-sender', notificationPreference: NotificationPreference.ALL },
    ]);

    await service.handleMessageSent(basePayload);

    expect(mockEventBus.publish).not.toHaveBeenCalled();
  });

  it('should skip online members', async () => {
    queryRunner.manager.find.mockResolvedValue([
      { userId: 'user-sender', notificationPreference: NotificationPreference.ALL },
      { userId: 'user-online', notificationPreference: NotificationPreference.ALL },
    ]);
    mockPresenceService.getOnlineUsers.mockResolvedValue(
      new Map([['user-online', true]]),
    );

    await service.handleMessageSent(basePayload);

    expect(mockEventBus.publish).not.toHaveBeenCalled();
  });

  it('should respect notification preference none', async () => {
    queryRunner.manager.find.mockResolvedValue([
      { userId: 'user-sender', notificationPreference: NotificationPreference.ALL },
      { userId: 'user-quiet', notificationPreference: NotificationPreference.NONE },
    ]);
    mockPresenceService.getOnlineUsers.mockResolvedValue(
      new Map([['user-quiet', false]]),
    );

    await service.handleMessageSent(basePayload);

    expect(mockEventBus.publish).not.toHaveBeenCalled();
  });

  it('should always notify @mentioned users (overrides mentions-only preference)', async () => {
    queryRunner.manager.find.mockResolvedValue([
      { userId: 'user-sender', notificationPreference: NotificationPreference.ALL },
      { userId: 'user-mentioned', notificationPreference: NotificationPreference.MENTIONS },
    ]);
    mockPresenceService.getOnlineUsers.mockResolvedValue(
      new Map([['user-mentioned', true]]),
    );

    await service.handleMessageSent({
      ...basePayload,
      mentionedUserIds: ['user-mentioned'],
    });

    expect(mockEventBus.publish).toHaveBeenCalledTimes(1);
    expect(mockEventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: 'user-mentioned' }),
    );
  });

  it('should deduplicate: max 1 push per 30s per user per channel', async () => {
    queryRunner.manager.find.mockResolvedValue([
      { userId: 'user-sender', notificationPreference: NotificationPreference.ALL },
      { userId: 'user-a', notificationPreference: NotificationPreference.ALL },
    ]);
    mockPresenceService.getOnlineUsers.mockResolvedValue(
      new Map([['user-a', false]]),
    );
    // Simulate dedup key already exists
    mockRedis.get.mockResolvedValue('1');

    await service.handleMessageSent(basePayload);

    expect(mockEventBus.publish).not.toHaveBeenCalled();
  });

  it('should never include message content in push payload', async () => {
    queryRunner.manager.find.mockResolvedValue([
      { userId: 'user-sender', notificationPreference: NotificationPreference.ALL },
      { userId: 'user-a', notificationPreference: NotificationPreference.ALL },
    ]);
    mockPresenceService.getOnlineUsers.mockResolvedValue(
      new Map([['user-a', false]]),
    );

    await service.handleMessageSent(basePayload);

    const emittedPayload = mockEventBus.publish.mock.calls[0]?.[0];
    expect(emittedPayload.notificationRef).toEqual(expect.any(String));
    expect(emittedPayload.notificationRef).not.toBe(basePayload.eventId);
    expect(JSON.stringify(emittedPayload)).not.toContain('content');
    expect(JSON.stringify(emittedPayload)).not.toContain(basePayload.channelId);
    expect(JSON.stringify(emittedPayload)).not.toContain(basePayload.messageId);
  });
});
