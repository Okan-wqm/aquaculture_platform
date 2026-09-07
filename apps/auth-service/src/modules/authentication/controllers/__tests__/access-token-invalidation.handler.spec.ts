import { type ITokenBlacklist, TOKEN_BLACKLIST } from '@aquaculture/backend-common/security';
import { Test, type TestingModule } from '@nestjs/testing';
import type { IEventBus } from '@platform/event-bus';
import {
  createBaseEvent,
  type AccessTokenInvalidationRequestedEvent,
} from '@platform/event-contracts';

import { AccessTokenInvalidationHandler } from '../access-token-invalidation.handler';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const JTI = '22222222-2222-4222-8222-222222222222';
const EXPIRES_AT = 1_785_559_300;

function invalidationEvent(): AccessTokenInvalidationRequestedEvent {
  return {
    ...createBaseEvent<AccessTokenInvalidationRequestedEvent>(
      'AccessTokenInvalidationRequested',
      TENANT_ID,
      { aggregateId: JTI, aggregateType: 'AccessToken' },
    ),
    targetJti: JTI,
    expiresAtEpochSeconds: EXPIRES_AT,
    reason: 'user_logout',
  };
}

describe('AccessTokenInvalidationHandler', () => {
  let testingModule: TestingModule;
  let eventBus: jest.Mocked<Pick<IEventBus, 'subscribeWildcard'>>;
  let tokenBlacklist: jest.Mocked<Pick<ITokenBlacklist, 'add'>>;
  let handler: AccessTokenInvalidationHandler;

  beforeEach(async () => {
    eventBus = {
      subscribeWildcard: jest.fn().mockResolvedValue(undefined),
    };
    tokenBlacklist = {
      add: jest.fn().mockResolvedValue(undefined),
    };
    testingModule = await Test.createTestingModule({
      providers: [
        AccessTokenInvalidationHandler,
        { provide: 'EVENT_BUS', useValue: eventBus },
        { provide: TOKEN_BLACKLIST, useValue: tokenBlacklist },
      ],
    }).compile();
    handler = testingModule.get(AccessTokenInvalidationHandler);
  });

  afterEach(async () => {
    await testingModule.close();
  });

  it('registers the versioned durable replay consumer during module initialization', async () => {
    await testingModule.init();

    expect(eventBus.subscribeWildcard).toHaveBeenCalledWith(
      'AccessTokenInvalidationRequested',
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

  it('applies the exact JTI expiry through the canonical blacklist writer', async () => {
    await handler.handle(invalidationEvent());

    expect(tokenBlacklist.add).toHaveBeenCalledWith(
      JTI,
      new Date(EXPIRES_AT * 1000),
      'user_logout',
    );
  });

  it('rejects malformed trust-boundary payloads without writing a marker', async () => {
    await expect(
      handler.handle({
        ...invalidationEvent(),
        expiresAtEpochSeconds: 'not-an-epoch',
      }),
    ).resolves.toEqual(
      // PLAT-HIGH-902: on this unlimited-redelivery consumer a throw was an
      // endless NAK loop; a malformed payload is terminated (dead-lettered).
      expect.objectContaining({
        kind: 'terminate',
        reason: 'Invalid AccessTokenInvalidationRequested event',
      }),
    );

    expect(tokenBlacklist.add).not.toHaveBeenCalled();
  });

  it('propagates Redis write failures so JetStream can redeliver', async () => {
    const redisFailure = new Error('Redis write failed');
    tokenBlacklist.add.mockRejectedValueOnce(redisFailure);

    await expect(handler.handle(invalidationEvent())).rejects.toBe(redisFailure);
  });
});
