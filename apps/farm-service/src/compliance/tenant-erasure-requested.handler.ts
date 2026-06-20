import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import type { TenantErasureRequestedEvent } from '@platform/event-contracts';

import { TenantErasureService } from './services/tenant-erasure.service';

@Injectable()
export class TenantErasureRequestedHandler
  implements IEventHandler<TenantErasureRequestedEvent>, OnModuleInit
{
  private readonly logger = new Logger(TenantErasureRequestedHandler.name);

  constructor(
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
    private readonly tenantErasureService: TenantErasureService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribeWildcard('TenantErasureRequested', this);
    this.logger.log('Subscribed to TenantErasureRequested for farm tenant erasure');
  }

  getEventType(): string {
    return 'TenantErasureRequested';
  }

  async handle(event: TenantErasureRequestedEvent): Promise<void> {
    await this.tenantErasureService.eraseFromTenantErasureRequest(event);
  }
}
