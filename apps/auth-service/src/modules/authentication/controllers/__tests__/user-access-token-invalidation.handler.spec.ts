import {
  type IUserTokenRevocation,
  USER_TOKEN_REVOCATION,
} from '@aquaculture/backend-common/security';
import {
  createBaseEvent,
  type UserAccessTokenInvalidationRequestedEvent,
} from '@platform/event-contracts';
import type { IEventBus } from '@platform/event-bus';
import { Test, type TestingModule } from '@nestjs/testing';

import { UserAccessTokenInvalidationHandler } from '../user-access-token-invalidation.handler';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const INVALIDATED_AT = 1_785_558_400;

function invalidationEvent(): UserAccessTokenInvalidationRequestedEvent {
  return {
    ...createBaseEvent<UserAccessTokenInvalidationRequestedEvent>(
      'UserAccessTokenInvalidationRequested',
      TENANT_ID,
      { aggregateId: USER_ID, aggregateType: 'User' },
    ),
    targetUserId: USER_ID,
    invalidatedAtEpochSeconds: INVALIDATED_AT,
    reason: 'refresh_token_reuse',
  };
}

describe('UserAccessTokenInvalidationHandler', () => {
  let testingModule: TestingModule;
  let eventBus: jest.Mocked<Pick<IEventBus, 'subscribeWildcard'>>;
  let userTokenRevocation: jest.Mocked<Pick<IUserTokenRevocation, 'revokeUserTokens'>>;
  let handler: UserAccessTokenInvalidationHandler;

  beforeEach(async () => {
    eventBus = {
      subscribeWildcard: jest.fn().mockResolvedValue(undefined),
    };
    userTokenRevocation = {
      revokeUserTokens: jest.fn().mockResolvedValue(undefined),
    };
    testingModule = await Test.createTestingModule({
      providers: [
        UserAccessTokenInvalidationHandler,
        { provide: 'EVENT_BUS', useValue: eventBus },
        { provide: USER_TOKEN_REVOCATION, useValue: userTokenRevocation },
      ],
    }).compile();
    handler = testingModule.get(UserAccessTokenInvalidationHandler);
  });

  afterEach(async () => {
    await testingModule.close();
  });

  it('registers the versioned durable replay consumer during module initialization', async () => {
    await testingModule.init();

    expect(eventBus.subscribeWildcard).toHaveBeenCalledWith(
      'UserAccessTokenInvalidationRequested',
      handler,
      {
        durable: true,
        maxRetries: -1,
        consumerVersion: 'v1',
        startFrom: 'beginning',
      },
    );
  });

  it('fails module initialization when the durable subscription cannot be registered', async () => {
    const subscriptionFailure = new Error('JetStream unavailable');
    eventBus.subscribeWildcard.mockRejectedValueOnce(subscriptionFailure);

    await expect(handler.onModuleInit()).rejects.toBe(subscriptionFailure);
  });

  it('applies the validated event epoch through the canonical max-only writer', async () => {
    await handler.handle(invalidationEvent());

    expect(userTokenRevocation.revokeUserTokens).toHaveBeenCalledWith(
      USER_ID,
      new Date(INVALIDATED_AT * 1000),
    );
  });

  it('is safe under at-least-once duplicate delivery', async () => {
    const event = invalidationEvent();
    await handler.handle(event);
    await handler.handle(event);

    expect(userTokenRevocation.revokeUserTokens).toHaveBeenCalledTimes(2);
    expect(userTokenRevocation.revokeUserTokens).toHaveBeenNthCalledWith(
      2,
      USER_ID,
      new Date(INVALIDATED_AT * 1000),
    );
  });

  it('rejects malformed trust-boundary payloads without writing a marker', async () => {
    await expect(
      handler.handle({
        ...invalidationEvent(),
        invalidatedAtEpochSeconds: 'not-an-epoch',
      }),
    ).rejects.toThrow('Invalid UserAccessTokenInvalidationRequested event');

    expect(userTokenRevocation.revokeUserTokens).not.toHaveBeenCalled();
  });

  it('propagates Redis write failures so JetStream can redeliver', async () => {
    const redisFailure = new Error('Redis write failed');
    userTokenRevocation.revokeUserTokens.mockRejectedValueOnce(redisFailure);

    await expect(handler.handle(invalidationEvent())).rejects.toBe(redisFailure);
  });
});
