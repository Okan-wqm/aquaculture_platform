/**
 * @module MessagingPushService Tests
 * @description Unit tests for push notification dispatch logic.
 * Validates sender skip, presence check, notification preferences,
 * @mention override, and deduplication.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MessagingPushService } from '../messaging-push.service';
import { ChannelMember, NotificationPreference } from '../../channel/entities/channel-member.entity';
import { PresenceService } from '../../presence/presence.service';
import { MessageService } from '../../message/services/message.service';
import { REDIS_CLIENT } from '../../shared/redis.provider';

describe('MessagingPushService', () => {
  let service: MessagingPushService;

  const mockMemberRepo = {
    find: jest.fn(),
  };

  const mockPresenceService = {
    getOnlineUsers: jest.fn(),
  };

  const mockMessageService = {
    getUnreadCount: jest.fn().mockResolvedValue(3),
  };

  const mockNatsClient = {
    emit: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
  };

  const mockRedis = {
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue('OK'),
  };

  const basePayload = {
    eventId: 'evt-1',
    tenantId: 'tenant-1',
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingPushService,
        { provide: getRepositoryToken(ChannelMember), useValue: mockMemberRepo },
        { provide: PresenceService, useValue: mockPresenceService },
        { provide: MessageService, useValue: mockMessageService },
        { provide: 'NATS_SERVICE', useValue: mockNatsClient },
        { provide: REDIS_CLIENT, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<MessagingPushService>(MessagingPushService);
  });

  it('should send push notifications to offline members', async () => {
    mockMemberRepo.find.mockResolvedValue([
      { userId: 'user-sender', notificationPreference: NotificationPreference.ALL },
      { userId: 'user-a', notificationPreference: NotificationPreference.ALL },
      { userId: 'user-b', notificationPreference: NotificationPreference.ALL },
    ]);
    mockPresenceService.getOnlineUsers.mockResolvedValue(
      new Map([['user-a', false], ['user-b', false]]),
    );

    await service.handleMessageSent(basePayload);

    expect(mockNatsClient.emit).toHaveBeenCalledTimes(2);
    expect(mockNatsClient.emit).toHaveBeenCalledWith(
      'commands.notification.sendPush',
      expect.objectContaining({
        userId: 'user-a',
        title: 'Alice',
        body: 'Sent you a message',
        data: expect.objectContaining({ type: 'CHAT_MESSAGE' }),
      }),
    );
  });

  it('should skip the message sender', async () => {
    mockMemberRepo.find.mockResolvedValue([
      { userId: 'user-sender', notificationPreference: NotificationPreference.ALL },
    ]);

    await service.handleMessageSent(basePayload);

    expect(mockNatsClient.emit).not.toHaveBeenCalled();
  });

  it('should skip online members', async () => {
    mockMemberRepo.find.mockResolvedValue([
      { userId: 'user-sender', notificationPreference: NotificationPreference.ALL },
      { userId: 'user-online', notificationPreference: NotificationPreference.ALL },
    ]);
    mockPresenceService.getOnlineUsers.mockResolvedValue(
      new Map([['user-online', true]]),
    );

    await service.handleMessageSent(basePayload);

    expect(mockNatsClient.emit).not.toHaveBeenCalled();
  });

  it('should respect notification preference none', async () => {
    mockMemberRepo.find.mockResolvedValue([
      { userId: 'user-sender', notificationPreference: NotificationPreference.ALL },
      { userId: 'user-quiet', notificationPreference: NotificationPreference.NONE },
    ]);
    mockPresenceService.getOnlineUsers.mockResolvedValue(
      new Map([['user-quiet', false]]),
    );

    await service.handleMessageSent(basePayload);

    expect(mockNatsClient.emit).not.toHaveBeenCalled();
  });

  it('should always notify @mentioned users (overrides mentions-only preference)', async () => {
    mockMemberRepo.find.mockResolvedValue([
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

    expect(mockNatsClient.emit).toHaveBeenCalledTimes(1);
    expect(mockNatsClient.emit).toHaveBeenCalledWith(
      'commands.notification.sendPush',
      expect.objectContaining({ userId: 'user-mentioned' }),
    );
  });

  it('should deduplicate: max 1 push per 30s per user per channel', async () => {
    mockMemberRepo.find.mockResolvedValue([
      { userId: 'user-sender', notificationPreference: NotificationPreference.ALL },
      { userId: 'user-a', notificationPreference: NotificationPreference.ALL },
    ]);
    mockPresenceService.getOnlineUsers.mockResolvedValue(
      new Map([['user-a', false]]),
    );
    // Simulate dedup key already exists
    mockRedis.get.mockResolvedValue('1');

    await service.handleMessageSent(basePayload);

    expect(mockNatsClient.emit).not.toHaveBeenCalled();
  });

  it('should never include message content in push payload', async () => {
    mockMemberRepo.find.mockResolvedValue([
      { userId: 'user-sender', notificationPreference: NotificationPreference.ALL },
      { userId: 'user-a', notificationPreference: NotificationPreference.ALL },
    ]);
    mockPresenceService.getOnlineUsers.mockResolvedValue(
      new Map([['user-a', false]]),
    );

    await service.handleMessageSent(basePayload);

    const emittedPayload = mockNatsClient.emit.mock.calls[0]?.[1];
    expect(emittedPayload?.body).toBe('Sent you a message');
    expect(JSON.stringify(emittedPayload)).not.toContain('content');
  });
});
