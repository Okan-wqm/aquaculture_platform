import { MessagingNatsBridgeService } from './messaging-nats-bridge.service';

describe('MessagingNatsBridgeService', () => {
  const configService = {
    get: jest.fn(),
  };
  const messagingGateway = {
    broadcastNewMessage: jest.fn(),
    broadcastMessageUpdated: jest.fn(),
    broadcastMessageDeleted: jest.fn(),
    broadcastReadReceipt: jest.fn(),
    broadcastChannelEvent: jest.fn(),
    evictUserFromChannel: jest.fn(),
  };

  let service: MessagingNatsBridgeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MessagingNatsBridgeService(configService as any, messagingGateway as any);
  });

  it('bridges forwarded message events to a dedicated socket event', () => {
    (service as any).handleEvent({
      eventId: 'evt-1',
      eventType: 'MessageForwarded',
      timestamp: '2026-05-27T00:00:00.000Z',
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      channelId: 'channel-1',
      messageId: 'msg-1',
      senderId: 'user-1',
      sourceMessageId: 'msg-source',
      sourceChannelId: 'channel-source',
      contentType: 'TEXT',
      createdAt: '2026-05-27T00:00:00.000Z',
    });

    expect(messagingGateway.broadcastChannelEvent).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'channel-1',
      'messageForwarded',
      expect.objectContaining({
        eventType: 'MessageForwarded',
        channelId: 'channel-1',
        messageId: 'msg-1',
        senderId: 'user-1',
      }),
    );
    const payload = messagingGateway.broadcastChannelEvent.mock.calls[0]?.[3];
    expect(payload).not.toHaveProperty('sourceMessageId');
    expect(payload).not.toHaveProperty('sourceChannelId');
  });

  it('evicts removed members before broadcasting the removal event', () => {
    (service as any).handleEvent({
      eventId: 'evt-removed',
      eventType: 'ChannelMemberRemoved',
      timestamp: '2026-05-27T00:00:00.000Z',
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      channelId: 'channel-1',
      userId: 'user-removed',
    });

    expect(messagingGateway.evictUserFromChannel).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'channel-1',
      'user-removed',
    );
    expect(messagingGateway.broadcastChannelEvent).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'channel-1',
      'channelMemberRemoved',
      expect.objectContaining({
        eventType: 'ChannelMemberRemoved',
        channelId: 'channel-1',
        userId: 'user-removed',
      }),
    );
  });

  it('bridges reaction and pin events without reusing messageUpdated payloads', () => {
    const base = {
      eventId: 'evt-2',
      timestamp: '2026-05-27T00:00:00.000Z',
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      channelId: 'channel-1',
      messageId: 'msg-1',
    };

    (service as any).handleEvent({
      ...base,
      eventType: 'ReactionAdded',
      userId: 'user-1',
      emoji: ':thumbsup:',
    });
    (service as any).handleEvent({
      ...base,
      eventId: 'evt-3',
      eventType: 'ReactionRemoved',
      userId: 'user-1',
      emoji: ':thumbsup:',
    });
    (service as any).handleEvent({
      ...base,
      eventId: 'evt-4',
      eventType: 'MessagePinned',
      pinnedBy: 'user-2',
    });
    (service as any).handleEvent({
      ...base,
      eventId: 'evt-5',
      eventType: 'MessageUnpinned',
      unpinnedBy: 'user-2',
    });

    expect(messagingGateway.broadcastChannelEvent).toHaveBeenNthCalledWith(
      1,
      base.tenantId,
      base.channelId,
      'reactionAdded',
      expect.objectContaining({ eventType: 'ReactionAdded', emoji: ':thumbsup:' }),
    );
    expect(messagingGateway.broadcastChannelEvent).toHaveBeenNthCalledWith(
      2,
      base.tenantId,
      base.channelId,
      'reactionRemoved',
      expect.objectContaining({ eventType: 'ReactionRemoved', emoji: ':thumbsup:' }),
    );
    expect(messagingGateway.broadcastChannelEvent).toHaveBeenNthCalledWith(
      3,
      base.tenantId,
      base.channelId,
      'messagePinned',
      expect.objectContaining({ eventType: 'MessagePinned', pinnedBy: 'user-2' }),
    );
    expect(messagingGateway.broadcastChannelEvent).toHaveBeenNthCalledWith(
      4,
      base.tenantId,
      base.channelId,
      'messageUnpinned',
      expect.objectContaining({ eventType: 'MessageUnpinned', unpinnedBy: 'user-2' }),
    );
    expect(messagingGateway.broadcastMessageUpdated).not.toHaveBeenCalled();
  });
});
