import { IUserTokenRevocation, USER_TOKEN_REVOCATION } from '@aquaculture/backend-common/security';
import {
  isUserAccessTokenInvalidationRequestedEvent,
  type UserAccessTokenInvalidationRequestedEvent,
} from '@platform/event-contracts';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { IEventBus, IEventHandler, HandlerOutcome } from '@platform/event-bus';

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

  async handle(payload: unknown): Promise<HandlerOutcome> {
    if (!isUserAccessTokenInvalidationRequestedEvent(payload)) {
      // PLAT-HIGH-902: an invalid payload can never become a valid one — on
      // this unlimited-redelivery consumer a throw was an endless NAK loop.
      // Dead-letter it; a Redis outage below still throws and retries, so an
      // outage is never ACKed as a successful recovery.
      return HandlerOutcome.terminate('Invalid UserAccessTokenInvalidationRequested event');
    }

    await this.userTokenRevocation.revokeUserTokens(
      payload.targetUserId,
      new Date(payload.invalidatedAtEpochSeconds * 1000),
    );
    return HandlerOutcome.ack();
  }
}
