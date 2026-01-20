/**
 * Usage Metering Service
 *
 * Captures and tracks resource usage events for metered billing.
 * Handles event ingestion, meter reset, and threshold alerting.
 *
 * OPTIMIZED: Redis persistence for distributed consistency and fault tolerance.
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisService } from '@aquaculture/backend-common';

/**
 * Types of metered resources
 */
export enum MeterType {
  API_CALLS = 'api_calls',
  DATA_STORAGE = 'data_storage',
  SENSOR_READINGS = 'sensor_readings',
  ALERTS_SENT = 'alerts_sent',
  REPORTS_GENERATED = 'reports_generated',
  USERS_ACTIVE = 'users_active',
  FARMS_ACTIVE = 'farms_active',
  PONDS_ACTIVE = 'ponds_active',
  SENSORS_ACTIVE = 'sensors_active',
  DATA_EXPORT = 'data_export',
  INTEGRATIONS = 'integrations',
  CUSTOM = 'custom',
}

/**
 * Usage event for tracking
 */
export interface UsageEvent {
  id: string;
  tenantId: string;
  meterType: MeterType;
  quantity: number;
  unit: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
  source?: string;
  userId?: string;
  resourceId?: string;
  idempotencyKey?: string;
}

/**
 * Meter configuration
 */
export interface MeterConfig {
  meterType: MeterType;
  resetPeriod: 'hourly' | 'daily' | 'weekly' | 'monthly' | 'billing_period';
  unit: string;
  thresholds?: UsageThreshold[];
  maxValue?: number;
  allowOverage?: boolean;
  overageRate?: number;
}

/**
 * Usage threshold for alerts
 */
export interface UsageThreshold {
  percentage: number; // 50, 75, 90, 100
  alertType: 'warning' | 'critical';
  notifyOnBreach: boolean;
  notifyRecipients?: string[];
}

/**
 * Current meter reading
 */
export interface MeterReading {
  tenantId: string;
  meterType: MeterType;
  currentValue: number;
  unit: string;
  periodStart: Date;
  periodEnd: Date;
  limit?: number;
  percentageUsed?: number;
  lastUpdated: Date;
  eventCount: number;
}

/**
 * Meter state for a tenant
 */
interface TenantMeterState {
  tenantId: string;
  meters: Map<MeterType, MeterReading>;
  processedEvents: Set<string>; // Idempotency tracking
  lastResetAt: Date;
}

/**
 * JSON-serializable version of TenantMeterState for Redis storage
 */
interface TenantMeterStateJson {
  tenantId: string;
  meters: Record<string, MeterReading>;
  processedEvents: string[];
  lastResetAt: string;
}

/**
 * Threshold breach event
 */
export interface ThresholdBreachEvent {
  tenantId: string;
  meterType: MeterType;
  threshold: UsageThreshold;
  currentValue: number;
  limit: number;
  percentageUsed: number;
  timestamp: Date;
}

/**
 * Event batch for bulk processing
 */
export interface UsageEventBatch {
  events: UsageEvent[];
  batchId: string;
  timestamp: Date;
}

@Injectable()
export class UsageMeteringService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UsageMeteringService.name);

  // In-memory state - in production, use Redis or database
  private readonly tenantStates = new Map<string, TenantMeterState>();
  private readonly meterConfigs = new Map<MeterType, MeterConfig>();
  private readonly eventBuffer: UsageEvent[] = [];
  private readonly maxBufferSize = 1000;
  private readonly breachedThresholds = new Map<string, Set<number>>(); // tenantId:meterType -> breached percentages

  private flushInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private redisWriteInterval: NodeJS.Timeout | null = null;
  private dirtyTenants = new Set<string>(); // Track which tenants need Redis sync

  // Metrics
  private metrics = {
    totalEventsReceived: 0,
    totalEventsProcessed: 0,
    duplicateEventsSkipped: 0,
    batchesProcessed: 0,
    thresholdBreaches: 0,
    errors: 0,
  };

  constructor(
    private readonly eventEmitter: EventEmitter2,
    @Optional()
    private readonly redisService?: RedisService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.initializeDefaultConfigs();

    // Load existing state from Redis if available
    await this.loadFromRedis();

    // Start periodic flush
    this.flushInterval = setInterval(
      () => this.flushEventBuffer(),
      5000, // Flush every 5 seconds
    );

    // Start periodic cleanup of old idempotency keys
    this.cleanupInterval = setInterval(
      () => this.cleanupOldIdempotencyKeys(),
      3600000, // Cleanup every hour
    );

    // Start periodic Redis sync for dirty tenants
    if (this.redisService) {
      this.redisWriteInterval = setInterval(
        () => this.syncToRedis(),
        10000, // Sync every 10 seconds
      );
    }

    this.logger.log('UsageMeteringService initialized with Redis persistence');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    if (this.redisWriteInterval) {
      clearInterval(this.redisWriteInterval);
      this.redisWriteInterval = null;
    }

    // Final flush
    this.flushEventBuffer();

    // Final Redis sync
    await this.syncToRedis();

    this.logger.log('UsageMeteringService shutdown - all data synced');
  }

  /**
   * Load tenant states from Redis on startup
   */
  private async loadFromRedis(): Promise<void> {
    if (!this.redisService) return;

    try {
      // Get all meter state keys
      const keys = await this.redisService.keys('metering:tenant:*');
      let loadedCount = 0;

      for (const key of keys) {
        try {
          const tenantId = key.replace('metering:tenant:', '');
          const data = await this.redisService.getJson<TenantMeterStateJson>(key);

          if (data) {
            // Reconstruct the state with proper types
            const meters = new Map<MeterType, MeterReading>();
            for (const [meterType, reading] of Object.entries(data.meters)) {
              meters.set(meterType as MeterType, {
                ...reading,
                periodStart: new Date(reading.periodStart),
                periodEnd: new Date(reading.periodEnd),
                lastUpdated: new Date(reading.lastUpdated),
              });
            }

            const state: TenantMeterState = {
              tenantId: data.tenantId,
              meters,
              processedEvents: new Set(data.processedEvents.slice(-1000)), // Keep last 1000 for idempotency
              lastResetAt: new Date(data.lastResetAt),
            };

            this.tenantStates.set(tenantId, state);
            loadedCount++;
          }
        } catch (err) {
          this.logger.warn(`Failed to load state for key ${key}: ${(err as Error).message}`);
        }
      }

      if (loadedCount > 0) {
        this.logger.log(`Loaded ${loadedCount} tenant meter states from Redis`);
      }
    } catch (err) {
      this.logger.error(`Failed to load from Redis: ${(err as Error).message}`);
    }
  }

  /**
   * Sync dirty tenant states to Redis
   */
  private async syncToRedis(): Promise<void> {
    if (!this.redisService || this.dirtyTenants.size === 0) return;

    const tenantIds = Array.from(this.dirtyTenants);
    this.dirtyTenants.clear();

    for (const tenantId of tenantIds) {
      const state = this.tenantStates.get(tenantId);
      if (!state) continue;

      try {
        // Convert to JSON-serializable format
        const metersObj: Record<string, MeterReading> = {};
        for (const [meterType, reading] of state.meters) {
          metersObj[meterType] = reading;
        }

        const data: TenantMeterStateJson = {
          tenantId: state.tenantId,
          meters: metersObj,
          processedEvents: Array.from(state.processedEvents).slice(-1000), // Keep last 1000
          lastResetAt: state.lastResetAt.toISOString(),
        };

        await this.redisService.setJson(`metering:tenant:${tenantId}`, data);
      } catch (err) {
        this.logger.warn(`Failed to sync tenant ${tenantId} to Redis: ${(err as Error).message}`);
        // Re-add to dirty set for retry
        this.dirtyTenants.add(tenantId);
      }
    }
  }

  /**
   * Initialize default meter configurations
   */
  private initializeDefaultConfigs(): void {
    const defaultThresholds: UsageThreshold[] = [
      { percentage: 50, alertType: 'warning', notifyOnBreach: false },
      { percentage: 75, alertType: 'warning', notifyOnBreach: true },
      { percentage: 90, alertType: 'critical', notifyOnBreach: true },
      { percentage: 100, alertType: 'critical', notifyOnBreach: true },
    ];

    this.registerMeterConfig({
      meterType: MeterType.API_CALLS,
      resetPeriod: 'monthly',
      unit: 'calls',
      thresholds: defaultThresholds,
      allowOverage: true,
      overageRate: 0.001, // $0.001 per extra call
    });

    this.registerMeterConfig({
      meterType: MeterType.DATA_STORAGE,
      resetPeriod: 'billing_period',
      unit: 'GB',
      thresholds: defaultThresholds,
      allowOverage: true,
      overageRate: 0.10, // $0.10 per extra GB
    });

    this.registerMeterConfig({
      meterType: MeterType.SENSOR_READINGS,
      resetPeriod: 'monthly',
      unit: 'readings',
      thresholds: defaultThresholds,
      allowOverage: true,
      overageRate: 0.0001, // $0.0001 per extra reading
    });

    this.registerMeterConfig({
      meterType: MeterType.ALERTS_SENT,
      resetPeriod: 'monthly',
      unit: 'alerts',
      thresholds: defaultThresholds,
      allowOverage: true,
      overageRate: 0.01, // $0.01 per extra alert
    });

    this.registerMeterConfig({
      meterType: MeterType.REPORTS_GENERATED,
      resetPeriod: 'monthly',
      unit: 'reports',
      thresholds: defaultThresholds,
      allowOverage: true,
      overageRate: 0.05, // $0.05 per extra report
    });

    this.registerMeterConfig({
      meterType: MeterType.USERS_ACTIVE,
      resetPeriod: 'billing_period',
      unit: 'users',
      thresholds: defaultThresholds,
      allowOverage: false,
    });

    this.registerMeterConfig({
      meterType: MeterType.FARMS_ACTIVE,
      resetPeriod: 'billing_period',
      unit: 'farms',
      thresholds: defaultThresholds,
      allowOverage: false,
    });

    this.registerMeterConfig({
      meterType: MeterType.PONDS_ACTIVE,
      resetPeriod: 'billing_period',
      unit: 'ponds',
      thresholds: defaultThresholds,
      allowOverage: false,
    });

    this.registerMeterConfig({
      meterType: MeterType.SENSORS_ACTIVE,
      resetPeriod: 'billing_period',
      unit: 'sensors',
      thresholds: defaultThresholds,
      allowOverage: false,
    });
  }

  /**
   * Register a meter configuration
   */
  registerMeterConfig(config: MeterConfig): void {
    this.meterConfigs.set(config.meterType, config);
    this.logger.debug(`Registered meter config: ${config.meterType}`);
  }

  /**
   * Get meter configuration
   */
  getMeterConfig(meterType: MeterType): MeterConfig | undefined {
    return this.meterConfigs.get(meterType);
  }

  /**
   * Record a usage event
   */
  recordUsage(event: Omit<UsageEvent, 'id' | 'timestamp'>): UsageEvent {
    const fullEvent: UsageEvent = {
      id: this.generateEventId(),
      timestamp: new Date(),
      ...event,
    };

    this.metrics.totalEventsReceived++;

    // Check idempotency
    if (event.idempotencyKey) {
      const state = this.getOrCreateTenantState(event.tenantId);
      if (state.processedEvents.has(event.idempotencyKey)) {
        this.metrics.duplicateEventsSkipped++;
        this.logger.debug(`Duplicate event skipped: ${event.idempotencyKey}`);
        return fullEvent;
      }
    }

    // Add to buffer
    this.eventBuffer.push(fullEvent);

    // Process immediately if buffer is full
    if (this.eventBuffer.length >= this.maxBufferSize) {
      this.flushEventBuffer();
    }

    return fullEvent;
  }

  /**
   * Record multiple usage events
   */
  recordUsageBatch(events: Array<Omit<UsageEvent, 'id' | 'timestamp'>>): UsageEventBatch {
    const batch: UsageEventBatch = {
      batchId: this.generateBatchId(),
      timestamp: new Date(),
      events: events.map(e => this.recordUsage(e)),
    };

    this.metrics.batchesProcessed++;
    return batch;
  }

  /**
   * Flush the event buffer
   */
  private flushEventBuffer(): void {
    if (this.eventBuffer.length === 0) return;

    const eventsToProcess = [...this.eventBuffer];
    this.eventBuffer.length = 0;

    for (const event of eventsToProcess) {
      this.processEvent(event);
    }

    this.logger.debug(`Flushed ${eventsToProcess.length} events`);
  }

  /**
   * Process a single event
   */
  private processEvent(event: UsageEvent): void {
    try {
      const state = this.getOrCreateTenantState(event.tenantId);

      // Track idempotency
      if (event.idempotencyKey) {
        state.processedEvents.add(event.idempotencyKey);
      }

      // Get or create meter reading
      const meter = this.getOrCreateMeterReading(state, event.meterType);

      // Update meter
      meter.currentValue += event.quantity;
      meter.lastUpdated = event.timestamp;
      meter.eventCount++;

      // Calculate percentage if limit is set
      if (meter.limit && meter.limit > 0) {
        meter.percentageUsed = (meter.currentValue / meter.limit) * 100;
      }

      // Check thresholds
      this.checkThresholds(event.tenantId, event.meterType, meter);

      // Mark tenant as dirty for Redis sync
      this.dirtyTenants.add(event.tenantId);

      this.metrics.totalEventsProcessed++;

      // Emit event
      this.eventEmitter.emit('usage.recorded', {
        tenantId: event.tenantId,
        meterType: event.meterType,
        quantity: event.quantity,
        currentValue: meter.currentValue,
        timestamp: event.timestamp,
      });
    } catch (error) {
      this.metrics.errors++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error processing event: ${errorMessage}`, event);
    }
  }

  /**
   * Check usage thresholds
   */
  private checkThresholds(
    tenantId: string,
    meterType: MeterType,
    meter: MeterReading,
  ): void {
    const config = this.meterConfigs.get(meterType);
    if (!config?.thresholds || !meter.limit) return;

    const percentageUsed = meter.percentageUsed || 0;
    const breachKey = `${tenantId}:${meterType}`;
    const breachedSet = this.breachedThresholds.get(breachKey) || new Set();

    for (const threshold of config.thresholds) {
      if (percentageUsed >= threshold.percentage && !breachedSet.has(threshold.percentage)) {
        // New breach
        breachedSet.add(threshold.percentage);
        this.breachedThresholds.set(breachKey, breachedSet);

        this.metrics.thresholdBreaches++;

        const breachEvent: ThresholdBreachEvent = {
          tenantId,
          meterType,
          threshold,
          currentValue: meter.currentValue,
          limit: meter.limit,
          percentageUsed,
          timestamp: new Date(),
        };

        this.eventEmitter.emit('usage.threshold.breached', breachEvent);

        if (threshold.notifyOnBreach) {
          this.logger.warn(
            `Usage threshold breached: ${tenantId} - ${meterType} at ${percentageUsed.toFixed(1)}%`,
          );
        }
      }
    }
  }

  /**
   * Get or create tenant state
   */
  private getOrCreateTenantState(tenantId: string): TenantMeterState {
    let state = this.tenantStates.get(tenantId);

    if (!state) {
      state = {
        tenantId,
        meters: new Map(),
        processedEvents: new Set(),
        lastResetAt: new Date(),
      };
      this.tenantStates.set(tenantId, state);
    }

    return state;
  }

  /**
   * Get or create meter reading
   */
  private getOrCreateMeterReading(
    state: TenantMeterState,
    meterType: MeterType,
  ): MeterReading {
    let meter = state.meters.get(meterType);

    if (!meter) {
      const config = this.meterConfigs.get(meterType);
      const now = new Date();

      meter = {
        tenantId: state.tenantId,
        meterType,
        currentValue: 0,
        unit: config?.unit || 'units',
        periodStart: this.getPeriodStart(config?.resetPeriod || 'monthly'),
        periodEnd: this.getPeriodEnd(config?.resetPeriod || 'monthly'),
        limit: config?.maxValue,
        percentageUsed: 0,
        lastUpdated: now,
        eventCount: 0,
      };

      state.meters.set(meterType, meter);
    }

    return meter;
  }

  /**
   * Get period start date
   */
  private getPeriodStart(resetPeriod: string): Date {
    const now = new Date();

    switch (resetPeriod) {
      case 'hourly':
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
      case 'daily':
        return new Date(now.getFullYear(), now.getMonth(), now.getDate());
      case 'weekly': {
        const dayOfWeek = now.getDay();
        const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
        return new Date(now.getFullYear(), now.getMonth(), diff);
      }
      case 'monthly':
      case 'billing_period':
      default:
        return new Date(now.getFullYear(), now.getMonth(), 1);
    }
  }

  /**
   * Get period end date
   */
  private getPeriodEnd(resetPeriod: string): Date {
    const start = this.getPeriodStart(resetPeriod);

    switch (resetPeriod) {
      case 'hourly':
        return new Date(start.getTime() + 3600000);
      case 'daily':
        return new Date(start.getTime() + 86400000);
      case 'weekly':
        return new Date(start.getTime() + 604800000);
      case 'monthly':
      case 'billing_period':
      default:
        return new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59, 999);
    }
  }

  /**
   * Get current meter reading
   */
  getMeterReading(tenantId: string, meterType: MeterType): MeterReading | undefined {
    const state = this.tenantStates.get(tenantId);
    return state?.meters.get(meterType);
  }

  /**
   * Get all meter readings for a tenant
   */
  getAllMeterReadings(tenantId: string): MeterReading[] {
    const state = this.tenantStates.get(tenantId);
    if (!state) return [];
    return Array.from(state.meters.values());
  }

  /**
   * Set meter limit
   */
  setMeterLimit(tenantId: string, meterType: MeterType, limit: number): void {
    const state = this.getOrCreateTenantState(tenantId);
    const meter = this.getOrCreateMeterReading(state, meterType);
    meter.limit = limit;

    if (limit > 0) {
      meter.percentageUsed = (meter.currentValue / limit) * 100;
    }

    this.logger.debug(`Set meter limit: ${tenantId} - ${meterType} = ${limit}`);
  }

  /**
   * Reset a meter
   */
  resetMeter(tenantId: string, meterType: MeterType, reason?: string): MeterReading | undefined {
    const state = this.tenantStates.get(tenantId);
    if (!state) return undefined;

    const meter = state.meters.get(meterType);
    if (!meter) return undefined;

    const previousValue = meter.currentValue;

    // Record the reset
    this.eventEmitter.emit('usage.meter.reset', {
      tenantId,
      meterType,
      previousValue,
      reason,
      timestamp: new Date(),
    });

    // Reset values
    meter.currentValue = 0;
    meter.percentageUsed = 0;
    meter.eventCount = 0;
    meter.lastUpdated = new Date();
    meter.periodStart = this.getPeriodStart(this.meterConfigs.get(meterType)?.resetPeriod || 'monthly');
    meter.periodEnd = this.getPeriodEnd(this.meterConfigs.get(meterType)?.resetPeriod || 'monthly');

    // Reset breached thresholds
    this.breachedThresholds.delete(`${tenantId}:${meterType}`);

    this.logger.log(`Meter reset: ${tenantId} - ${meterType} (was ${previousValue})`);
    return meter;
  }

  /**
   * Reset all meters for a tenant
   */
  resetAllMeters(tenantId: string, reason?: string): void {
    const state = this.tenantStates.get(tenantId);
    if (!state) return;

    for (const meterType of state.meters.keys()) {
      this.resetMeter(tenantId, meterType, reason);
    }

    state.lastResetAt = new Date();
    state.processedEvents.clear();

    this.logger.log(`All meters reset for tenant: ${tenantId}`);
  }

  /**
   * Check if usage is within limits
   */
  isWithinLimits(tenantId: string, meterType: MeterType): boolean {
    const meter = this.getMeterReading(tenantId, meterType);
    if (!meter || !meter.limit) return true;
    return meter.currentValue <= meter.limit;
  }

  /**
   * Get remaining usage
   */
  getRemainingUsage(tenantId: string, meterType: MeterType): number | null {
    const meter = this.getMeterReading(tenantId, meterType);
    if (!meter || !meter.limit) return null;
    return Math.max(0, meter.limit - meter.currentValue);
  }

  /**
   * Calculate overage
   */
  getOverage(tenantId: string, meterType: MeterType): number {
    const meter = this.getMeterReading(tenantId, meterType);
    if (!meter || !meter.limit) return 0;
    return Math.max(0, meter.currentValue - meter.limit);
  }

  /**
   * Calculate overage cost
   */
  getOverageCost(tenantId: string, meterType: MeterType): number {
    const overage = this.getOverage(tenantId, meterType);
    if (overage <= 0) return 0;

    const config = this.meterConfigs.get(meterType);
    if (!config?.overageRate || !config.allowOverage) return 0;

    return overage * config.overageRate;
  }

  /**
   * Get metrics
   */
  getMetrics(): typeof this.metrics {
    return { ...this.metrics };
  }

  /**
   * Cleanup old idempotency keys
   */
  private cleanupOldIdempotencyKeys(): void {
    for (const state of this.tenantStates.values()) {
      // Keep only recent keys (clear if over limit)
      if (state.processedEvents.size > 100000) {
        state.processedEvents.clear();
        this.logger.debug(`Cleared idempotency keys for tenant: ${state.tenantId}`);
      }
    }
  }

  /**
   * Generate event ID
   */
  private generateEventId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate batch ID
   */
  private generateBatchId(): string {
    return `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get usage summary for a tenant
   */
  getUsageSummary(tenantId: string): {
    meters: MeterReading[];
    totalOverageCost: number;
    metersAtLimit: MeterType[];
    metersOverLimit: MeterType[];
  } {
    const meters = this.getAllMeterReadings(tenantId);
    let totalOverageCost = 0;
    const metersAtLimit: MeterType[] = [];
    const metersOverLimit: MeterType[] = [];

    for (const meter of meters) {
      if (meter.limit) {
        const overage = meter.currentValue - meter.limit;
        if (overage > 0) {
          metersOverLimit.push(meter.meterType);
          const config = this.meterConfigs.get(meter.meterType);
          if (config?.overageRate && config.allowOverage) {
            totalOverageCost += overage * config.overageRate;
          }
        } else if (meter.currentValue === meter.limit) {
          metersAtLimit.push(meter.meterType);
        }
      }
    }

    return {
      meters,
      totalOverageCost,
      metersAtLimit,
      metersOverLimit,
    };
  }

  /**
   * Export usage data for a tenant
   */
  exportUsageData(tenantId: string): {
    tenantId: string;
    exportedAt: Date;
    meters: MeterReading[];
    configs: MeterConfig[];
  } {
    return {
      tenantId,
      exportedAt: new Date(),
      meters: this.getAllMeterReadings(tenantId),
      configs: Array.from(this.meterConfigs.values()),
    };
  }
}
