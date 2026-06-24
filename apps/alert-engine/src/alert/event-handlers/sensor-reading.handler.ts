import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { IEventBus, IEventHandler, IEvent } from '@platform/event-bus';
import { getTenantSchemaName, isValidUUID } from '@aquaculture/backend-common/database';
import { requestContextStorage, RequestContext } from '@aquaculture/backend-common/logging';
import { AlertEvaluationService } from '../services/alert-evaluation.service';

// UUID validation imported from @aquaculture/backend-common (isValidUUID)

/**
 * Sensor Reading Event interface (v2 — flat fields)
 * Upcaster in NatsEventBus converts v1 nested `readings` to flat `readingXxx` fields.
 */
interface SensorReadingEvent extends IEvent {
  eventType: 'SensorReading';
  sensorId: string;
  farmId?: string;
  pondId?: string;
  readingTemperature?: number;
  readingPh?: number;
  readingDissolvedOxygen?: number;
  readingSalinity?: number;
  readingAmmonia?: number;
  readingNitrite?: number;
  readingNitrate?: number;
  readingTurbidity?: number;
  readingWaterLevel?: number;
}

/** ARCH-C01: Flat reading fields → Record<string, number> for evaluationService */
const READING_FIELD_MAP: Record<string, string> = {
  readingTemperature: 'temperature',
  readingPh: 'ph',
  readingDissolvedOxygen: 'dissolvedOxygen',
  readingSalinity: 'salinity',
  readingAmmonia: 'ammonia',
  readingNitrite: 'nitrite',
  readingNitrate: 'nitrate',
  readingTurbidity: 'turbidity',
  readingWaterLevel: 'waterLevel',
};

/**
 * Extract flat readingXxx fields into a Record<string, number> for internal use.
 */
function extractReadingsFromEvent(event: SensorReadingEvent): Record<string, number> {
  const readings: Record<string, number> = {};
  for (const [flatField, paramName] of Object.entries(READING_FIELD_MAP)) {
    const value = event[flatField as keyof SensorReadingEvent];
    if (typeof value === 'number') {
      readings[paramName] = value;
    }
  }
  return readings;
}

/**
 * Sensor Reading Event Handler
 * Listens to sensor readings and evaluates them against alert rules.
 *
 * IMPORTANT: NATS event handlers run OUTSIDE HTTP request context.
 * There is NO AsyncLocalStorage context and NO TenantSchemaMiddleware.
 * We must manually create an AsyncLocalStorage context with the correct
 * schemaName so that TenantConnectionBootstrap's pool patch routes each
 * connection checkout to the correct tenant schema.
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
    // Subscribe to SensorReading events ACROSS EVERY TENANT.
    //
    // WHAT — `subscribeWildcard` builds `events.*.SensorReading` (3 segments),
    // matching the publisher's `events.{tenantId}.SensorReading` for every
    // tenant + the platform `events.system.SensorReading` channel.
    //
    // WHY explicit `subscribeWildcard` over the legacy `subscribe` helper —
    // `subscribe` also wildcards under the hood, but its name does not
    // express intent; that ambiguity is what ORPHAN-013 documented. Using
    // `subscribeWildcard` here makes the cross-tenant fan-out unambiguous at
    // the call site, and a future refactor that switches the alert engine to
    // per-tenant routing only has to flip this single line to
    // `subscribeForTenant(eventType, tenantId, this)`.
    await this.eventBus.subscribeWildcard('SensorReading', this);
    this.logger.log('Subscribed to SensorReading events (cross-tenant wildcard)');
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
      const readings = extractReadingsFromEvent(event);

      await requestContextStorage.run(context, async () => {
        await this.evaluationService.evaluateSensorReading({
          sensorId: event.sensorId,
          tenantId: event.tenantId!,
          readings,
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
