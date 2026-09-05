import { TENANT_ERASURE_REQUEST_SUBSCRIPTION_OPTIONS } from '@aquaculture/backend-common/compliance';
import { withTenantContext } from '@aquaculture/backend-common/context';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { IEventBus, IEventHandler, HandlerOutcome } from '@platform/event-bus';
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
    await this.eventBus.subscribeWildcard(
      'TenantErasureRequested',
      this,
      TENANT_ERASURE_REQUEST_SUBSCRIPTION_OPTIONS,
    );
    this.logger.log('Subscribed to TenantErasureRequested for farm tenant erasure');
  }

  getEventType(): string {
    return 'TenantErasureRequested';
  }

  async handle(event: TenantErasureRequestedEvent): Promise<HandlerOutcome> {
    // A NATS event handler has no HTTP request context. Erasure is a
    // tenant-scoped destructive operation, so establish the tenant frame
    // (search_path + RLS GUC) before the service runs — matching the
    // harvest-completed / mortality-recorded / onboarding handlers — so the
    // erasure cannot accidentally execute against the source schema or under a
    // missing tenant context. withTenantContext fails closed on an invalid
    // tenantId, which is the correct posture for a destructive op.
    await withTenantContext(event.tenantId, () =>
      this.tenantErasureService.eraseFromTenantErasureRequest(event),
    );
    return HandlerOutcome.ack();
  }
}
