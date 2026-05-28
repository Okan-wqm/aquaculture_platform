import { createBaseEvent } from '@platform/event-contracts';
import type { ChatPushRequestedEvent, MessageSentEvent } from '@platform/event-contracts';
import { MessagingEventHandler } from '../messaging-event.handler';

describe('MessagingEventHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const recipientUserId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  const inAppService = {
    createNotification: jest.fn(),
  };
  const pushService = {
    sendPushNotification: jest.fn(),
  };
  const dlqService = {
    handleFailedEvent: jest.fn().mockResolvedValue({ retry: false, retryCount: 0 }),
  };
  const deviceTokenRepository = {
    find: jest.fn(),
  };
  const eventBus = {
    subscribeWildcard: jest.fn(),
    publish: jest.fn(),
  };

  let handler: MessagingEventHandler;

  beforeEach(() => {
    jest.clearAllMocks();
    deviceTokenRepository.find.mockResolvedValue([]);
    pushService.sendPushNotification.mockResolvedValue('push-1');
    handler = new MessagingEventHandler(
      inAppService as any,
      pushService as any,
      dlqService as any,
      deviceTokenRepository as any,
      eventBus as any,
    );
  });

  it('subscribes to durable ChatPushRequested events', async () => {
    await handler.onModuleInit();

    expect(eventBus.subscribeWildcard).toHaveBeenCalledWith('MessageSent', handler);
    expect(eventBus.subscribeWildcard).toHaveBeenCalledWith('ChatPushRequested', handler);
    expect(eventBus.subscribeWildcard).toHaveBeenCalledWith('AnnouncementPublished', handler);
    expect(eventBus.subscribeWildcard).toHaveBeenCalledWith('BulkThreadsCreated', handler);
  });

  it('sends chat push to tenant-scoped recipient device tokens', async () => {
    deviceTokenRepository.find.mockResolvedValue([
      { id: 'dev-1', tenantId, userId: recipientUserId, token: 'token-1' },
      { id: 'dev-2', tenantId, userId: recipientUserId, token: 'token-2' },
    ]);

    const event: ChatPushRequestedEvent = {
      ...createBaseEvent<ChatPushRequestedEvent>('ChatPushRequested', tenantId, {
        aggregateId: 'chat-notification-1',
        aggregateType: 'ChatPushRequest',
      }),
      recipientUserId,
      notificationRef: 'chat-notification-1',
      badge: 7,
      notificationType: 'CHAT_MESSAGE',
    };

    await handler.handle(event);

    expect(deviceTokenRepository.find).toHaveBeenCalledWith({
      where: { tenantId, userId: recipientUserId },
    });
    expect(pushService.sendPushNotification).toHaveBeenCalledTimes(2);
    expect(pushService.sendPushNotification).toHaveBeenCalledWith(
      'token-1',
      expect.objectContaining({
        title: 'New message',
        body: 'Sent you a message',
        badge: 7,
        sound: 'default',
        data: expect.objectContaining({
          type: 'CHAT_MESSAGE',
          notificationRef: 'chat-notification-1',
        }),
      }),
    );
  });

  it('keeps legacy MessageSent on the support-thread in-app path only', async () => {
    const event: MessageSentEvent = {
      ...createBaseEvent<MessageSentEvent>('MessageSent', tenantId, {
        aggregateId: 'thread-1',
        aggregateType: 'Thread',
      }),
      messageId: 'msg-legacy',
      threadId: 'thread-1',
      senderId: 'sender-1',
      senderType: 'super_admin',
      senderName: 'Support',
      isInternal: false,
    };

    await handler.handle(event);

    expect(inAppService.createNotification).toHaveBeenCalledWith(
      tenantId,
      tenantId,
      'New message received',
      'New message from platform support',
      expect.objectContaining({
        type: 'MESSAGE',
        threadId: 'thread-1',
        messageId: 'msg-legacy',
      }),
    );
    expect(pushService.sendPushNotification).not.toHaveBeenCalled();
    expect(deviceTokenRepository.find).not.toHaveBeenCalled();
  });
});
