import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IEventBus, IEventHandler, HandlerOutcome } from '@platform/event-bus';
import type { UserDeletedEvent } from '@platform/event-contracts';
import { Repository } from 'typeorm';

import { DeviceToken } from '../entities/device-token.entity';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

@Injectable()
export class DeviceTokenRevocationHandler implements IEventHandler<UserDeletedEvent>, OnModuleInit {
  private readonly logger = new Logger(DeviceTokenRevocationHandler.name);

  constructor(
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
    @InjectRepository(DeviceToken)
    private readonly deviceTokenRepository: Repository<DeviceToken>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribeWildcard('UserDeleted', this);
    this.logger.log('Subscribed to UserDeleted for device-token revocation');
  }

  getEventType(): string {
    return 'DeviceTokenRevocation';
  }

  async handle(event: UserDeletedEvent): Promise<HandlerOutcome> {
    if (!UUID_REGEX.test(event.tenantId) || !UUID_REGEX.test(event.deletedUserId)) {
      this.logger.error('Rejected UserDeleted with invalid tenantId/deletedUserId');
      return HandlerOutcome.terminate('UserDeleted: invalid tenantId or deletedUserId');
    }

    const result = await this.deviceTokenRepository.delete({
      tenantId: event.tenantId,
      userId: event.deletedUserId,
    });
    if ((result.affected ?? 0) > 0) {
      this.logger.log(
        `Revoked ${result.affected} device tokens for deletedUserId=${event.deletedUserId}`,
      );
    }
    return HandlerOutcome.ack();
  }
}
