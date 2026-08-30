/**
 * London-school spec for ConversationPrivacyEventHandler — the ai-service side
 * of the GDPR erasure cascade (ADR-044 / DB-PEOPLE-MEDIUM-004 / INC-MSG-1).
 *
 * WHY this spec exists: messaging-service no longer reaches into
 * `agent_conversations` with cross-service SQL; it relies entirely on this
 * consumer erasing ai-service's own runner-context blob when
 * `GdprAnonymizeRequested` (or `UserDeleted`) arrives. These tests pin that
 * reliance: subscription wiring, erasure delegation for both event types,
 * input validation, and fail-loud error propagation (NATS redelivery owns
 * the retry — the handler must not swallow).
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  createBaseEvent,
  type GdprAnonymizeRequestedEvent,
  type UserDeletedEvent,
} from '@platform/event-contracts';

import { ConversationPrivacyEventHandler } from '../conversation-privacy-event.handler';
import { ConversationService } from '../conversation.service';

describe('ConversationPrivacyEventHandler (ADR-044 erasure cascade consumer)', () => {
  let handler: ConversationPrivacyEventHandler;
  let eventBus: { subscribeWildcard: jest.Mock };
  let conversationService: { eraseForUser: jest.Mock };

  const tenantId = '00000000-0000-4000-8000-000000000001';
  const targetUserId = '00000000-0000-4000-8000-0000000000aa';
  const requestId = '00000000-0000-4000-8000-0000000000bb';

  const gdprEvent = (): GdprAnonymizeRequestedEvent => ({
    ...createBaseEvent<GdprAnonymizeRequestedEvent>('GdprAnonymizeRequested', tenantId),
    userId: targetUserId,
    requestId,
    fulfilByIso: new Date('2026-08-12T00:00:00.000Z').toISOString(),
  });

  const userDeletedEvent = (): UserDeletedEvent => ({
    ...createBaseEvent<UserDeletedEvent>('UserDeleted', tenantId),
    deletedUserId: targetUserId,
    hardDelete: true,
    cascadeRequested: true,
    initiatedBy: 'gdpr-erasure',
    cryptoShredKeyId: '00000000-0000-4000-8000-0000000000cc',
  });

  beforeEach(async () => {
    eventBus = { subscribeWildcard: jest.fn().mockResolvedValue(undefined) };
    conversationService = { eraseForUser: jest.fn().mockResolvedValue(1) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationPrivacyEventHandler,
        { provide: 'EVENT_BUS', useValue: eventBus },
        { provide: ConversationService, useValue: conversationService },
      ],
    }).compile();

    handler = module.get(ConversationPrivacyEventHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('subscribes cross-tenant to UserDeleted and GdprAnonymizeRequested on module init', async () => {
    await handler.onModuleInit();

    expect(eventBus.subscribeWildcard).toHaveBeenCalledWith('UserDeleted', handler);
    expect(eventBus.subscribeWildcard).toHaveBeenCalledWith('GdprAnonymizeRequested', handler);
    expect(eventBus.subscribeWildcard).toHaveBeenCalledTimes(2);
  });

  it('erases the agent_conversations blob for the GdprAnonymizeRequested target', async () => {
    await handler.handle(gdprEvent());

    expect(conversationService.eraseForUser).toHaveBeenCalledWith(tenantId, targetUserId);
  });

  it('erases for UserDeleted using deletedUserId (not the acting BaseEvent.userId)', async () => {
    const event = userDeletedEvent();
    // The actor who requested the delete must never be the erasure target.
    event.userId = '00000000-0000-4000-8000-0000000000dd';

    await handler.handle(event);

    expect(conversationService.eraseForUser).toHaveBeenCalledWith(tenantId, targetUserId);
  });

  it('rejects an event with a non-UUID tenantId without touching the store', async () => {
    const event = gdprEvent();
    event.tenantId = 'not-a-uuid';

    await handler.handle(event);

    expect(conversationService.eraseForUser).not.toHaveBeenCalled();
  });

  it('rejects an event with a non-UUID target user id without touching the store', async () => {
    const event = gdprEvent();
    event.userId = 'drop table users';

    await handler.handle(event);

    expect(conversationService.eraseForUser).not.toHaveBeenCalled();
  });

  it('propagates erasure failures so the event bus redelivers (no swallow)', async () => {
    conversationService.eraseForUser.mockRejectedValueOnce(new Error('db down'));

    await expect(handler.handle(gdprEvent())).rejects.toThrow('db down');
  });
});
