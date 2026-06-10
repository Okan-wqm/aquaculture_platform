/**
 * @module MessagingPushService Tests
 * @description Unit tests for push notification dispatch logic.
 * Validates sender skip, presence check, notification preferences,
 * @mention override, and deduplication.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NOTIFICATION_COMMAND_SUBJECTS } from '@platform/event-contracts';
import { of } from 'rxjs';

import {
  ChannelMember,
  NotificationPreference,
} from '../../channel/entities/channel-member.entity';
import { MessageService } from '../../message/services/message.service';
import { PresenceService } from '../../presence/presence.service';
import { REDIS_CLIENT } from '../../shared/redis.provider';
import { MessagingPushService } from '../messaging-push.service';

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
    send: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
  };

  const mockRedis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };

  interface PushCommandPayload {
    deliveryId: string;
    requestReference: string;
    tenantId: string;
    source: string;
    recipientRef: {
      kind: string;
      ref: string;
    };
    templateId: string;
    templateVersion: string;
    templateVariables: {
      type: string;
      notificationRef: string;
      badge?: number;
      channelId?: unknown;
      messageId?: unknown;
    };
  }

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

  const isPushCommandPayload = (value: unknown): value is PushCommandPayload =>
    isRecord(value) &&
    typeof value['deliveryId'] === 'string' &&
    typeof value['requestReference'] === 'string' &&
    typeof value['tenantId'] === 'string' &&
    typeof value['source'] === 'string' &&
    isRecord(value['recipientRef']) &&
    value['recipientRef']['kind'] === 'userId' &&
    typeof value['recipientRef']['ref'] === 'string' &&
    typeof value['templateId'] === 'string' &&
    typeof value['templateVersion'] === 'string' &&
    isRecord(value['templateVariables']) &&
    typeof value['templateVariables']['type'] === 'string' &&
    typeof value['templateVariables']['notificationRef'] === 'string';

  const getEmittedPushPayload = (index = 0): PushCommandPayload => {
    const call: unknown = mockNatsClient.send.mock.calls[index];
    if (!Array.isArray(call) || !isPushCommandPayload(call[1])) {
      throw new Error(`Missing push command payload at call ${index}`);
    }
    return call[1];
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
    mockRedis.get.mockResolvedValue(null);
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.setex.mockResolvedValue('OK');
    mockRedis.del.mockResolvedValue(1);
    mockMessageService.getUnreadCount.mockResolvedValue(3);
    mockNatsClient.send.mockReturnValue(of({ success: true }));

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
      new Map([
        ['user-a', false],
        ['user-b', false],
      ]),
    );

    await service.handleMessageSent(basePayload);

    expect(mockNatsClient.send).toHaveBeenCalledTimes(2);
    expect(mockNatsClient.send).toHaveBeenCalledWith(
      NOTIFICATION_COMMAND_SUBJECTS.SEND_PUSH,
      expect.objectContaining({
        tenantId: 'tenant-1',
        source: 'messaging-service',
        recipientRef: { kind: 'userId', ref: 'user-a' },
        templateId: 'messaging.chat.message.push',
        templateVersion: '1',
        templateVariables: expect.objectContaining({
          senderName: 'Alice',
          type: 'CHAT_MESSAGE',
          notificationRef: getEmittedPushPayload(0).templateVariables.notificationRef,
        }) as Record<string, unknown>,
      }),
    );
    expect(getEmittedPushPayload(0).templateVariables.notificationRef).toHaveLength(36);
  });

  it('should skip the message sender', async () => {
    mockMemberRepo.find.mockResolvedValue([
      { userId: 'user-sender', notificationPreference: NotificationPreference.ALL },
    ]);

    await service.handleMessageSent(basePayload);

    expect(mockNatsClient.send).not.toHaveBeenCalled();
  });

  it('should skip online members', async () => {
    mockMemberRepo.find.mockResolvedValue([
      { userId: 'user-sender', notificationPreference: NotificationPreference.ALL },
      { userId: 'user-online', notificationPreference: NotificationPreference.ALL },
    ]);
    mockPresenceService.getOnlineUsers.mockResolvedValue(new Map([['user-online', true]]));

    await service.handleMessageSent(basePayload);

    expect(mockNatsClient.send).not.toHaveBeenCalled();
  });

  it('should respect notification preference none', async () => {
    mockMemberRepo.find.mockResolvedValue([
      { userId: 'user-sender', notificationPreference: NotificationPreference.ALL },
      { userId: 'user-quiet', notificationPreference: NotificationPreference.NONE },
    ]);
    mockPresenceService.getOnlineUsers.mockResolvedValue(new Map([['user-quiet', false]]));

    await service.handleMessageSent(basePayload);

    expect(mockNatsClient.send).not.toHaveBeenCalled();
  });

  it('should always notify @mentioned users (overrides mentions-only preference)', async () => {
    mockMemberRepo.find.mockResolvedValue([
      { userId: 'user-sender', notificationPreference: NotificationPreference.ALL },
      { userId: 'user-mentioned', notificationPreference: NotificationPreference.MENTIONS },
    ]);
    mockPresenceService.getOnlineUsers.mockResolvedValue(new Map([['user-mentioned', true]]));

    await service.handleMessageSent({
      ...basePayload,
      mentionedUserIds: ['user-mentioned'],
    });

    expect(mockNatsClient.send).toHaveBeenCalledTimes(1);
    expect(mockNatsClient.send).toHaveBeenCalledWith(
      NOTIFICATION_COMMAND_SUBJECTS.SEND_PUSH,
      expect.objectContaining({
        recipientRef: { kind: 'userId', ref: 'user-mentioned' },
      }),
    );
  });

  it('should deduplicate: max 1 push per 30s per user per channel', async () => {
    mockMemberRepo.find.mockResolvedValue([
      { userId: 'user-sender', notificationPreference: NotificationPreference.ALL },
      { userId: 'user-a', notificationPreference: NotificationPreference.ALL },
    ]);
    mockPresenceService.getOnlineUsers.mockResolvedValue(new Map([['user-a', false]]));
    // Simulate atomic dedup claim already held.
    mockRedis.set.mockResolvedValue(null);

    await service.handleMessageSent(basePayload);

    expect(mockNatsClient.send).not.toHaveBeenCalled();
    expect(mockRedis.set).toHaveBeenCalledWith(
      'msg:push:dedup:tenant-1:channel-1:user-a',
      'msg-1',
      'EX',
      30,
      'NX',
    );
  });

  it('should never include message content in push payload', async () => {
    mockMemberRepo.find.mockResolvedValue([
      { userId: 'user-sender', notificationPreference: NotificationPreference.ALL },
      { userId: 'user-a', notificationPreference: NotificationPreference.ALL },
    ]);
    mockPresenceService.getOnlineUsers.mockResolvedValue(new Map([['user-a', false]]));

    await service.handleMessageSent(basePayload);

    const emittedPayload = getEmittedPushPayload();
    expect(emittedPayload.templateId).toBe('messaging.chat.message.push');
    expect(JSON.stringify(emittedPayload)).not.toContain('content');
    expect(emittedPayload.templateVariables).not.toHaveProperty('channelId');
    expect(emittedPayload.templateVariables).not.toHaveProperty('messageId');
  });

  it('rolls back failed recipient refs without stopping other recipients', async () => {
    mockMemberRepo.find.mockResolvedValue([
      { userId: 'user-sender', notificationPreference: NotificationPreference.ALL },
      { userId: 'user-a', notificationPreference: NotificationPreference.ALL },
      { userId: 'user-b', notificationPreference: NotificationPreference.ALL },
    ]);
    mockPresenceService.getOnlineUsers.mockResolvedValue(
      new Map([
        ['user-a', false],
        ['user-b', false],
      ]),
    );
    mockNatsClient.send
      .mockReturnValueOnce(of({ success: false, error: 'provider failed' }))
      .mockReturnValueOnce(of({ success: true }));

    await service.handleMessageSent(basePayload);

    expect(mockNatsClient.send).toHaveBeenCalledTimes(2);
    expect(mockRedis.del).toHaveBeenCalledWith('msg:push:dedup:tenant-1:channel-1:user-a');
    const [setexKey] = mockRedis.setex.mock.calls[0] as readonly unknown[];
    expect(mockRedis.del).toHaveBeenCalledWith(setexKey);
    expect(mockRedis.del).not.toHaveBeenCalledWith('msg:push:dedup:tenant-1:channel-1:user-b');
  });
});
