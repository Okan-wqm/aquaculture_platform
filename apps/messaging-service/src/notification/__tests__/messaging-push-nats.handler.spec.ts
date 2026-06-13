import { Test } from '@nestjs/testing';
import type { MessageSentEvent } from '@platform/event-contracts';

import { MessagingPushNatsHandler } from '../messaging-push-nats.handler';
import { MessagingPushService } from '../messaging-push.service';

/**
 * MSG-HIGH-004 regression coverage: the handler must own the durable
 * MessageSent subscription and delegate to the (already content-free) push
 * fan-out, so offline channel-message push is no longer dead.
 */
describe('MessagingPushNatsHandler', () => {
  const handleMessageSent = jest.fn<Promise<void>, [MessageSentEvent]>();
  const subscribeWildcard = jest.fn<Promise<void>, [string, unknown]>();

  let handler: MessagingPushNatsHandler;

  beforeEach(async () => {
    handleMessageSent.mockReset().mockResolvedValue(undefined);
    subscribeWildcard.mockReset().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        MessagingPushNatsHandler,
        { provide: MessagingPushService, useValue: { handleMessageSent } },
        { provide: 'EVENT_BUS', useValue: { subscribeWildcard } },
      ],
    }).compile();

    handler = moduleRef.get(MessagingPushNatsHandler);
  });

  it('subscribes to the durable MessageSent fan-out on init', async () => {
    await handler.onModuleInit();
    expect(subscribeWildcard).toHaveBeenCalledWith('MessageSent', handler);
  });

  it('reports MessageSent as its event type', () => {
    expect(handler.getEventType()).toBe('MessageSent');
  });

  it('delegates each MessageSent event to MessagingPushService.handleMessageSent', async () => {
    const event = {
      eventType: 'MessageSent',
      eventId: 'evt-1',
      tenantId: '11111111-1111-4111-8111-111111111111',
      channelId: 'chan-1',
      messageId: 'msg-1',
      senderId: 'user-1',
      contentType: 'text',
      hasAttachments: false,
      createdAt: '2026-06-13T12:00:00.000Z',
    } as MessageSentEvent;

    await handler.handle(event);

    expect(handleMessageSent).toHaveBeenCalledWith(event);
  });
});
