import { ITokenBlacklist, TOKEN_BLACKLIST } from '@aquaculture/backend-common/security';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
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

  async handle(payload: unknown): Promise<void> {
    if (!isAccessTokenInvalidationRequestedEvent(payload)) {
      throw new Error('Invalid AccessTokenInvalidationRequested event');
    }
    await this.tokenBlacklist.add(
      payload.targetJti,
      new Date(payload.expiresAtEpochSeconds * 1000),
      payload.reason,
    );
  }
}
