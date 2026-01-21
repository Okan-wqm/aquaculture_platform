import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { IEventBus, IEventHandler, IEvent } from '@platform/event-bus';
import { AlertEvaluationService } from '../services/alert-evaluation.service';

/**
 * Sensor Reading Event interface
 */
interface SensorReadingEvent extends IEvent {
  eventType: 'SensorReading';
  sensorId: string;
  readings: Record<string, number>;
  farmId?: string;
  pondId?: string;
}

/**
 * Sensor Reading Event Handler
 * Listens to sensor readings and evaluates them against alert rules
 */
@Injectable()
export class SensorReadingEventHandler
  implements IEventHandler<SensorReadingEvent>, OnModuleInit
{
  private readonly logger = new Logger(SensorReadingEventHandler.name);

  constructor(
    private readonly evaluationService: AlertEvaluationService,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    // Subscribe to sensor reading events
    await this.eventBus.subscribe('SensorReading', this);
    this.logger.log('Subscribed to SensorReading events');
  }

  getEventType(): string {
    return 'SensorReading';
  }

  async handle(event: SensorReadingEvent): Promise<void> {
    this.logger.debug(
      `Processing sensor reading from ${event.sensorId}`,
    );

    // SECURITY: tenantId is required for multi-tenant isolation
    // Empty string fallback could cause cross-tenant data leakage
    if (!event.tenantId) {
      this.logger.error(
        `Missing tenantId for sensor reading from ${event.sensorId}. ` +
        'Skipping alert evaluation to prevent multi-tenant isolation breach.',
      );
      return;
    }

    try {
      await this.evaluationService.evaluateSensorReading({
        sensorId: event.sensorId,
        tenantId: event.tenantId,
        readings: event.readings,
        farmId: event.farmId,
        pondId: event.pondId,
        timestamp: event.timestamp,
      });
    } catch (error) {
      this.logger.error(
        `Error processing sensor reading: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
