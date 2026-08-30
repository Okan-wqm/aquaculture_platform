import { IUserTokenRevocation, USER_TOKEN_REVOCATION } from '@aquaculture/backend-common/security';
import {
  isUserAccessTokenInvalidationRequestedEvent,
  type UserAccessTokenInvalidationRequestedEvent,
} from '@platform/event-contracts';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';

@Injectable()
export class UserAccessTokenInvalidationHandler
  implements IEventHandler<UserAccessTokenInvalidationRequestedEvent>, OnModuleInit
{
  constructor(
    @Inject('EVENT_BUS') private readonly eventBus: IEventBus,
    @Inject(USER_TOKEN_REVOCATION)
    private readonly userTokenRevocation: IUserTokenRevocation,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribeWildcard('UserAccessTokenInvalidationRequested', this, {
      durable: true,
      maxRetries: -1,
      consumerVersion: 'v1',
      startFrom: 'beginning',
    });
  }

  getEventType(): string {
    return 'UserAccessTokenInvalidationRequested';
  }

  async handle(payload: unknown): Promise<void> {
    if (!isUserAccessTokenInvalidationRequestedEvent(payload)) {
      // Throwing deliberately NAKs the JetStream delivery. Invalid payloads
      // and Redis outages must never be ACKed as successful recovery.
      throw new Error('Invalid UserAccessTokenInvalidationRequested event');
    }

    await this.userTokenRevocation.revokeUserTokens(
      payload.targetUserId,
      new Date(payload.invalidatedAtEpochSeconds * 1000),
    );
  }
}
