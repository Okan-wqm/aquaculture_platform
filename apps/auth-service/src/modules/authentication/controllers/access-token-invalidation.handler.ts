import { ITokenBlacklist, TOKEN_BLACKLIST } from '@aquaculture/backend-common/security';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { IEventBus, IEventHandler, HandlerOutcome } from '@platform/event-bus';
import {
  isAccessTokenInvalidationRequestedEvent,
  type AccessTokenInvalidationRequestedEvent,
} from '@platform/event-contracts';

@Injectable()
export class AccessTokenInvalidationHandler
  implements IEventHandler<AccessTokenInvalidationRequestedEvent>, OnModuleInit
{
  constructor(
    @Inject('EVENT_BUS') private readonly eventBus: IEventBus,
    @Inject(TOKEN_BLACKLIST) private readonly tokenBlacklist: ITokenBlacklist,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribeWildcard('AccessTokenInvalidationRequested', this, {
      durable: true,
      maxRetries: -1,
      consumerVersion: 'v1',
      startFrom: 'beginning',
    });
  }

  getEventType(): string {
    return 'AccessTokenInvalidationRequested';
  }

  async handle(payload: unknown): Promise<HandlerOutcome> {
    if (!isAccessTokenInvalidationRequestedEvent(payload)) {
      // PLAT-HIGH-902: an invalid payload can never become a valid one — on
      // this unlimited-redelivery consumer a throw was an endless NAK loop.
      // Dead-letter it; a Redis outage below still throws and retries.
      return HandlerOutcome.terminate('Invalid AccessTokenInvalidationRequested event');
    }
    await this.tokenBlacklist.add(
      payload.targetJti,
      new Date(payload.expiresAtEpochSeconds * 1000),
      payload.reason,
    );
    return HandlerOutcome.ack();
  }
}
