import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import {
  type TelemetryCapacityEntitlementChangedEvent,
  validateTelemetryCapacityEvent,
} from '@platform/event-contracts';

import { TelemetryCapacityProjectionService } from '../services/telemetry-capacity-projection.service';

@Injectable()
export class TelemetryCapacityEntitlementChangedHandler
  implements IEventHandler<TelemetryCapacityEntitlementChangedEvent>, OnModuleInit
{
  private readonly logger = new Logger(TelemetryCapacityEntitlementChangedHandler.name);

  constructor(
    private readonly projectionService: TelemetryCapacityProjectionService,
    @Inject('EVENT_BUS') private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribeWildcard(this.getEventType(), this);
    this.logger.log('Subscribed to telemetry capacity entitlement changes');
  }

  getEventType(): string {
    return 'TelemetryCapacityEntitlementChanged';
  }

  async handle(event: TelemetryCapacityEntitlementChangedEvent): Promise<void> {
    const validation = validateTelemetryCapacityEvent(event);
    if (!validation.valid) {
      throw new Error(`Invalid telemetry capacity event: ${validation.errors}`);
    }
    await this.projectionService.project(event);
  }
}
