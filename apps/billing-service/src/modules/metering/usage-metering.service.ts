/**
 * Usage Metering Service
 *
 * Captures and tracks resource usage events for metered billing.
 * Handles event ingestion, meter reset, and threshold alerting.
 *
 * OPTIMIZED: Redis persistence for distributed consistency and fault tolerance.
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { isCanaryTenant } from '@aquaculture/backend-common/billing';
import { RedisService } from '@aquaculture/backend-common/redis';
import { randomUUID } from 'crypto';

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
  timestamp: string;
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
  lastUpdated: string;
  eventCount: number;
}

/**
 * Meter state for a tenant
 *
 * # lastTouchedAtMs (BILLING-LOW-001 cure)
 *
 * Wall-clock millisecond timestamp updated on every
 * getOrCreateTenantState() call. The periodic cleanup sweep
 * (cleanupStaleTenantStates) evicts entire entries whose
 * lastTouchedAtMs is older than the staleness window. Without
 * this field tenant states grew unboundedly across tenant
 * lifetime (the original BILLING-LOW-001 finding).
 *
 * Why a touch timestamp instead of a tenant-cancellation hook:
 * the cancellation path is asynchronous (NATS event from
 * billing-service → metering subscription cancellation handler)
 * and would miss tenants that simply went silent. The
 * touch-timestamp approach captures both cases — explicit
 * cancellation marks the tenant inactive (timestamp ages out);
 * silent abandonment ages out too. Subsumed by the eventual
 * full Redis-backed redesign in BILLING-CRITICAL-003 — this
 * cure is the minimum-viable bound until that lands.
 */
interface TenantMeterState {
  tenantId: string;
  meters: Map<MeterType, MeterReading>;
  processedEvents: Map<string, number>; // Idempotency key -> timestamp
  lastResetAt: Date;
  lastTouchedAtMs: number;
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
  timestamp: string;
}

/**
 * Event batch for bulk processing
 */
export interface UsageEventBatch {
  events: UsageEvent[];
  batchId: string;
  timestamp: string;
}

/**
 * Counters describing what the meter did with what it was handed.
 *
 * Named and exported rather than inferred from a private field: a caller
 * that wants to assert on `canaryEventsSkipped` should be able to say what
 * shape it expects without casting through the type system, and a cast in a
 * test is a claim nothing checks.
 */
export interface UsageMeteringMetrics {
  totalEventsReceived: number;
  totalEventsProcessed: number;
  duplicateEventsSkipped: number;
  canaryEventsSkipped: number;
  batchesProcessed: number;
  thresholdBreaches: number;
  errors: number;
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

  private dirtyTenants = new Set<string>(); // Track which tenants need Redis sync

  // Exponential backoff state for failed Redis syncs — prevents tight retry loops under outages
  private readonly syncRetryState = new Map<string, { attempts: number; nextRetryAt: number }>();
  private static readonly SYNC_RETRY_BASE_DELAY_MS = 1_000;
  private static readonly SYNC_RETRY_MAX_DELAY_MS = 5 * 60 * 1_000; // 5 minutes cap

  // Metrics
  private metrics: UsageMeteringMetrics = {
    totalEventsReceived: 0,
    totalEventsProcessed: 0,
    duplicateEventsSkipped: 0,
    canaryEventsSkipped: 0,
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
    // HIGH-04: Redis is required for metering durability. Without Redis, in-memory
    // metering state is lost on any restart/crash, allowing tenants to consume metered
    // resources without those usages being billed (revenue loss).
    if (!this.redisService) {
      throw new Error(
        'SECURITY: RedisService is required for UsageMeteringService. ' +
          'Configure REDIS_URL/REDIS_HOST and ensure the Redis connection is available.',
      );
    }

    this.initializeDefaultConfigs();

    // Load existing state from Redis. The periodic flush / cleanup / Redis-sync
    // timers are now Nest `@Interval` methods (registered with
    // SchedulerRegistry via ScheduleModule), replacing the hand-rolled
    // `setInterval` handles this service used to manage by hand — Nest owns
    // their lifecycle and stops them on shutdown.
    await this.loadFromRedis();

    this.logger.log('UsageMeteringService initialized with Redis persistence');
  }

  async onModuleDestroy(): Promise<void> {
    // The periodic timers are Nest `@Interval`s, torn down automatically by
    // ScheduleModule on shutdown; we only force a final drain of in-memory
    // state so nothing buffered is lost.
    this.flushEventBuffer();
    await this.syncToRedis();

    this.logger.log('UsageMeteringService shutdown - all data synced');
  }

  /**
   * Periodic event-buffer flush (Billing Revival Faz E).
   *
   * WHY `@Interval` not `setInterval`: the billing app wires
   * `ScheduleModule.forRoot()`; a hand-rolled `setInterval` bypassed Nest's
   * SchedulerRegistry (unmanaged lifecycle, not discoverable, only testable via
   * wall-clock advancement). `@Interval` makes the timer Nest-managed and lets
   * callers drive a flush deterministically.
   *
   * WHAT: every 5s, drain the in-memory event buffer into per-tenant meter
   * readings. `flushEventBuffer` is a no-op when the buffer is empty.
   */
  @Interval('metering-flush-events', 5000)
  runScheduledFlush(): void {
    this.flushEventBuffer();
  }

  /**
   * Periodic Redis durability sync (Billing Revival Faz E).
   *
   * WHY `@Interval` not `setInterval`: same lifecycle/observability reasoning
   * as {@link runScheduledFlush}. Redis is mandatory (onModuleInit fails
   * closed without it), so this always registers; `syncToRedis` internally
   * guards on `dirtyTenants` and returns early when there is nothing to write.
   *
   * WHAT: every 10s, upsert dirty tenant meter states to Redis.
   */
  @Interval('metering-redis-sync', 10000)
  async runScheduledRedisSync(): Promise<void> {
    await this.syncToRedis();
  }

  /**
   * Periodic in-memory maintenance sweep (Billing Revival Faz E).
   *
   * JUDGMENT (per Faz E scope note): the old hourly `cleanupInterval` evicts
   * aged idempotency keys AND stale tenant states (BILLING-LOW-001) — purely
   * in-memory bookkeeping, not a billing-durability timer, so it "may
   * legitimately stay setInterval". It is converted here anyway so that NO raw
   * `setInterval` survives in the metering module and every periodic task is
   * uniformly owned by Nest's scheduler. Both sweeps share one tick because
   * they walk the same in-memory `tenantStates` map.
   *
   * WHAT: hourly, evict idempotency keys older than 1h and tenant states idle
   * beyond the staleness window.
   */
  @Interval('metering-cleanup', 3600000)
  runScheduledCleanup(): void {
    this.cleanupOldIdempotencyKeys();
    this.cleanupStaleTenantStates();
  }

  /**
   * Load tenant states from Redis on startup
   */
  private async loadFromRedis(): Promise<void> {
    if (!this.redisService) return;

    try {
      // RedisService.keys() already uses SCAN internally — no blocking KEYS command
      const keys = await this.redisService.keys('metering:tenant:*');
      if (keys.length === 0) return;

      // Fire all reads concurrently instead of N sequential awaits
      const rawValues = await Promise.all(keys.map((key) => this.redisService!.getJson<TenantMeterStateJson>(key)));

      let loadedCount = 0;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        const data = rawValues[i];
        if (!data) continue;

        try {
          const tenantId = key.replace('metering:tenant:', '');

          // Reconstruct the state with proper types
          const meters = new Map<MeterType, MeterReading>();
          for (const [meterType, reading] of Object.entries(data.meters)) {
            meters.set(meterType as MeterType, {
              ...reading,
              periodStart: new Date(reading.periodStart),
              periodEnd: new Date(reading.periodEnd),
              lastUpdated: reading.lastUpdated,
            });
          }

          // Reconstruct processedEvents as Map<string, number> from the serialized array
          const processedEvents = new Map<string, number>();
          const now = Date.now();
          for (const evtKey of data.processedEvents.slice(-1000)) {
            processedEvents.set(evtKey, now);
          }

          const state: TenantMeterState = {
            tenantId: data.tenantId,
            meters,
            processedEvents,
            lastResetAt: new Date(data.lastResetAt),
            // Recently-loaded counts as recently-touched so the
            // cleanup sweep doesn't immediately evict tenants
            // we just rehydrated from Redis.
            lastTouchedAtMs: Date.now(),
          };

          this.tenantStates.set(tenantId, state);
          loadedCount++;
        } catch (err) {
          this.logger.warn(`Failed to parse state for key ${key}: ${(err as Error).message}`);
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

    const now = Date.now();
    const tenantIds = Array.from(this.dirtyTenants);
    this.dirtyTenants.clear();

    for (const tenantId of tenantIds) {
      // Exponential backoff: skip tenants that are not yet due for retry
      const retryState = this.syncRetryState.get(tenantId);
      if (retryState && retryState.nextRetryAt > now) {
        // Not ready for retry yet — re-queue but don't attempt
        this.dirtyTenants.add(tenantId);
        continue;
      }

      const state = this.tenantStates.get(tenantId);
      if (!state) {
        this.syncRetryState.delete(tenantId);
        continue;
      }

      try {
        // Convert to JSON-serializable format
        const metersObj: Record<string, MeterReading> = {};
        for (const [meterType, reading] of state.meters) {
          metersObj[meterType] = reading;
        }

        const data: TenantMeterStateJson = {
          tenantId: state.tenantId,
          meters: metersObj,
          processedEvents: Array.from(state.processedEvents.keys()).slice(-1000), // Keep last 1000 keys
          lastResetAt: state.lastResetAt.toISOString(),
        };

        await this.redisService.setJson(`metering:tenant:${tenantId}`, data);
        // Success — clear backoff state
        this.syncRetryState.delete(tenantId);
      } catch (err) {
        this.logger.warn(`Failed to sync tenant ${tenantId} to Redis: ${(err as Error).message}`);
        // Exponential backoff before next retry
        const attempts = (retryState?.attempts ?? 0) + 1;
        const delay = Math.min(
          UsageMeteringService.SYNC_RETRY_BASE_DELAY_MS * Math.pow(2, attempts - 1),
          UsageMeteringService.SYNC_RETRY_MAX_DELAY_MS,
        );
        this.syncRetryState.set(tenantId, { attempts, nextRetryAt: now + delay });
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
      timestamp: new Date().toISOString(),
      ...event,
    };

    this.metrics.totalEventsReceived++;

    // Synthetic traffic from an authorised canary tenant never becomes
    // billable. The refusal lives HERE, at the one place usage enters the
    // buffer, rather than as a rule each caller remembers: a canary that
    // bills is a canary nobody keeps running, and its usage would be
    // indistinguishable from a customer's in revenue reporting.
    //
    // Counted rather than dropped in silence - an exemption that leaves no
    // trace is how a mis-set env var becomes an invisible revenue hole.
    if (isCanaryTenant(event.tenantId)) {
      this.metrics.canaryEventsSkipped++;
      this.logger.debug(`Canary tenant usage not metered: ${event.meterType}`);
      return fullEvent;
    }

    // Check idempotency
    if (event.idempotencyKey) {
      const state = this.getOrCreateTenantState(event.tenantId);
      if (state.processedEvents.has(event.idempotencyKey)) {
        this.metrics.duplicateEventsSkipped++;
        this.logger.debug(`Duplicate event skipped: ${event.idempotencyKey}`);
        return fullEvent;
      }
      // Record with timestamp for age-based eviction
      state.processedEvents.set(event.idempotencyKey, Date.now());
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
      timestamp: new Date().toISOString(),
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

      // Track idempotency (already recorded in recordUsage, but ensure it's set for direct processEvent calls)
      if (event.idempotencyKey && !state.processedEvents.has(event.idempotencyKey)) {
        state.processedEvents.set(event.idempotencyKey, Date.now());
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
          timestamp: new Date().toISOString(),
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
   * Get or create tenant state. Updates lastTouchedAtMs on every
   * call so the BILLING-LOW-001 cleanup sweep can age out
   * abandoned tenants.
   */
  private getOrCreateTenantState(tenantId: string): TenantMeterState {
    let state = this.tenantStates.get(tenantId);

    if (!state) {
      state = {
        tenantId,
        meters: new Map(),
        processedEvents: new Map(),
        lastResetAt: new Date(),
        lastTouchedAtMs: Date.now(),
      };
      this.tenantStates.set(tenantId, state);
    } else {
      // Touch the timestamp so the cleanup sweep doesn't evict
      // an active tenant. Cheap (single Date.now() + property
      // assignment) and runs on every metering interaction.
      state.lastTouchedAtMs = Date.now();
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
        lastUpdated: now.toISOString(),
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
      timestamp: new Date().toISOString(),
    });

    // Reset values
    meter.currentValue = 0;
    meter.percentageUsed = 0;
    meter.eventCount = 0;
    meter.lastUpdated = new Date().toISOString();
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
    state.processedEvents = new Map();

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
  getMetrics(): UsageMeteringMetrics {
    return { ...this.metrics };
  }

  /**
   * Cleanup old idempotency keys by age (evict keys older than 1 hour)
   */
  private cleanupOldIdempotencyKeys(): void {
    const maxAgeMs = 60 * 60 * 1000; // 1 hour
    const cutoff = Date.now() - maxAgeMs;

    for (const state of this.tenantStates.values()) {
      let evicted = 0;
      for (const [key, timestamp] of state.processedEvents) {
        if (timestamp < cutoff) {
          state.processedEvents.delete(key);
          evicted++;
        }
      }
      if (evicted > 0) {
        this.logger.debug(`Evicted ${evicted} old idempotency keys for tenant: ${state.tenantId}`);
      }
    }
  }

  /**
   * Default staleness window for tenant-state eviction (BILLING-LOW-001).
   *
   * 24h is the architectural choice that:
   *   - keeps state for the standard daily metering rollup window
   *     (so a once-a-day usage report still finds yesterday's
   *     state in memory),
   *   - evicts tenants that genuinely went silent (cancellation
   *     event lost, subscription deleted out-of-band, tenant
   *     hibernated for the weekend) within an operationally
   *     reasonable horizon.
   *
   * The metering service rehydrates from Redis on startup, so
   * eviction does NOT lose data — it only frees memory until
   * the tenant interacts again.
   */
  private static readonly TENANT_STATE_STALENESS_MS = 24 * 60 * 60 * 1000;

  /**
   * Evict tenant states whose lastTouchedAtMs is older than the
   * staleness window (BILLING-LOW-001 cure). Also drops the
   * companion `breachedThresholds` entries for the evicted
   * tenant so that map doesn't outgrow tenantStates.
   *
   * # Why this is safe to do without coordination
   *
   * Eviction frees memory for tenants the in-process metering
   * loop hasn't seen for 24h. If the tenant becomes active
   * again, getOrCreateTenantState() rehydrates from Redis (via
   * loadFromRedis on the next sync cycle) or creates a fresh
   * state. The Redis-backed durability layer is the source of
   * truth; the in-memory map is a hot-path cache.
   *
   * The architecturally cleaner long-term fix is the
   * BILLING-CRITICAL-003 redesign which makes Redis the only
   * state surface and removes the in-memory map entirely. This
   * sweep is the minimum-viable bound until that lands.
   */
  private cleanupStaleTenantStates(): void {
    const cutoff = Date.now() - UsageMeteringService.TENANT_STATE_STALENESS_MS;
    let evicted = 0;
    const evictedTenantIds: string[] = [];

    for (const [tenantId, state] of this.tenantStates) {
      if (state.lastTouchedAtMs < cutoff) {
        this.tenantStates.delete(tenantId);
        evictedTenantIds.push(tenantId);
        evicted++;
      }
    }

    // Drop companion breachedThresholds entries for evicted
    // tenants. The key shape is `${tenantId}:${meterType}` so
    // we sweep by prefix.
    for (const evictedTenantId of evictedTenantIds) {
      for (const key of this.breachedThresholds.keys()) {
        if (key.startsWith(`${evictedTenantId}:`)) {
          this.breachedThresholds.delete(key);
        }
      }
    }

    if (evicted > 0) {
      this.logger.log(
        `Evicted ${evicted} stale tenant states (idle > ${UsageMeteringService.TENANT_STATE_STALENESS_MS / 1000 / 60 / 60}h). ` +
          `Active tenants remaining: ${this.tenantStates.size}`,
      );
    }
  }

  /**
   * Generate event ID using cryptographically secure random
   */
  private generateEventId(): string {
    return `evt_${randomUUID()}`;
  }

  /**
   * Generate batch ID using cryptographically secure random
   */
  private generateBatchId(): string {
    return `batch_${randomUUID()}`;
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
