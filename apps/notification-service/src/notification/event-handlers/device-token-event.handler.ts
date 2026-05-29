import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import type { UserDeletedEvent } from '@platform/event-contracts';

import { DeviceToken } from '../entities/device-token.entity';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class DeviceTokenEventHandler implements IEventHandler<UserDeletedEvent>, OnModuleInit {
  private readonly logger = new Logger(DeviceTokenEventHandler.name);

  constructor(
    @InjectRepository(DeviceToken)
    private readonly deviceTokenRepository: Repository<DeviceToken>,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribeWildcard('UserDeleted', this);
    this.logger.log('Subscribed to UserDeleted for device-token revocation');
  }

  getEventType(): string {
    return 'UserDeleted';
  }

  async handle(event: UserDeletedEvent): Promise<void> {
    if (!UUID_REGEX.test(event.tenantId) || !UUID_REGEX.test(event.deletedUserId)) {
      this.logger.warn('Rejected UserDeleted device-token cleanup with invalid UUID payload');
      return;
    }

    const result = await this.deviceTokenRepository.delete({
      tenantId: event.tenantId,
      userId: event.deletedUserId,
    });

    if ((result.affected ?? 0) > 0) {
      this.logger.log(
        `Revoked ${result.affected} device token(s) for deleted user ${event.deletedUserId.substring(0, 8)}...`,
      );
    }
  }
}
