import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import { PARAMETER_BY_READING_FIELD, type SensorReadingEvent } from '@platform/event-contracts';
import { getTenantSchemaName, isValidUUID } from '@aquaculture/backend-common/database';
import { requestContextStorage, RequestContext } from '@aquaculture/backend-common/logging';
import { AlertEvaluationService } from '../services/alert-evaluation.service';

type SensorReadingEvaluator = Pick<AlertEvaluationService, 'evaluateSensorReading'>;
type SensorReadingSubscriptionBus = Pick<IEventBus, 'subscribeWildcard' | 'subscribeTo'>;

// UUID validation imported from @aquaculture/backend-common (isValidUUID)

/**
 * Extract the flat `readingXxx` fields of a SensorReadingEvent into a
 * `Record<parameter, value>` for the evaluation service.
 *
 * The flat-field ↔ parameter mapping is the single source of truth
 * `PARAMETER_BY_READING_FIELD` (SENSOR-MEDIUM-066/068) — the same table the
 * sensor-service producer builds its events from, so a new parameter is added
 * in exactly one place and producer + consumer stay in lock-step by
 * construction rather than by two hand-copied maps kept in sync.
 */
function extractReadingsFromEvent(event: SensorReadingEvent): Record<string, number> {
  const readings: Record<string, number> = {};
  for (const [flatField, paramName] of Object.entries(PARAMETER_BY_READING_FIELD)) {
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
export class SensorReadingEventHandler implements IEventHandler<SensorReadingEvent>, OnModuleInit {
  private readonly logger = new Logger(SensorReadingEventHandler.name);

  constructor(
    @Inject(AlertEvaluationService)
    private readonly evaluationService: SensorReadingEvaluator,
    @Inject('EVENT_BUS')
    private readonly eventBus: SensorReadingSubscriptionBus,
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
    const durableOptions = {
      startFrom: 'beginning' as const,
      maxRetries: -1,
    };
    await this.eventBus.subscribeWildcard('SensorReading', this, {
      ...durableOptions,
      consumerVersion: 'sensor-reading-v2-legacy',
    });
    await this.eventBus.subscribeTo('telemetry.*.SensorReading', this, {
      ...durableOptions,
      consumerVersion: 'sensor-reading-v2-telemetry',
    });
    this.logger.log('Subscribed to legacy and telemetry SensorReading streams');
  }

  getEventType(): string {
    return 'SensorReading';
  }

  // getTenantSchemaName imported from @aquaculture/backend-common

  async handle(event: SensorReadingEvent): Promise<void> {
    this.logger.debug(`Processing sensor reading from ${event.sensorId}`);

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
          sourceEventId: event.eventId,
          sensorId: event.sensorId,
          tenantId: event.tenantId,
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
      throw error;
    }
  }
}
