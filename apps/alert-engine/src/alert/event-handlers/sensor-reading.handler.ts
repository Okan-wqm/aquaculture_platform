import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { IEventBus, IEventHandler, IEvent } from '@platform/event-bus';
import { requestContextStorage, RequestContext, getTenantSchemaName, isValidUUID } from '@aquaculture/backend-common';
import { AlertEvaluationService } from '../services/alert-evaluation.service';

// UUID validation imported from @aquaculture/backend-common (isValidUUID)

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
 * Listens to sensor readings and evaluates them against alert rules.
 *
 * IMPORTANT: NATS event handlers run OUTSIDE HTTP request context.
 * There is NO AsyncLocalStorage context and NO TenantSchemaMiddleware.
 * We must manually create an AsyncLocalStorage context with the correct
 * schemaName so that TenantConnectionBootstrap's pool patch injects
 * the correct SET search_path on every connection checkout.
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
    // Must match the topic published by sensor-service: 'SensorReading'
    await this.eventBus.subscribe('SensorReading', this);
    this.logger.log('Subscribed to SensorReading events');
  }

  getEventType(): string {
    return 'SensorReading';
  }

  // getTenantSchemaName imported from @aquaculture/backend-common

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

    // Validate UUID format to prevent schema name injection
    if (!isValidUUID(event.tenantId)) {
      this.logger.error(
        `Invalid tenantId format for sensor reading from ${event.sensorId}: ${event.tenantId}. Skipping.`,
      );
      return;
    }

    // NATS handlers have NO AsyncLocalStorage context.
    // TenantConnectionBootstrap reads schemaName from AsyncLocalStorage
    // on every pool connection checkout. We must manually create the context
    // so that all repository calls within evaluateSensorReading() use the
    // correct tenant schema.
    const schemaName = getTenantSchemaName(event.tenantId);
    const context: RequestContext = {
      tenantId: event.tenantId,
      schemaName,
      correlationId: event.correlationId,
    };

    try {
      await requestContextStorage.run(context, async () => {
        await this.evaluationService.evaluateSensorReading({
          sensorId: event.sensorId,
          tenantId: event.tenantId!,
          readings: event.readings,
          farmId: event.farmId,
          pondId: event.pondId,
          timestamp: event.timestamp,
        });
      });
    } catch (error) {
      this.logger.error(
        `Error processing sensor reading: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
