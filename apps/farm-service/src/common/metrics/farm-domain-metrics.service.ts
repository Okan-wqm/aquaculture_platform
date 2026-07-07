/**
 * FarmDomainMetricsService
 *
 * Prometheus counters + histograms for farm-service domain events.
 * Follows the same per-service registry pattern used by
 * messaging-service and sensor-service — a private `prom-client`
 * Registry that prevents label-set collisions with the global
 * registry and the per-service HTTP metrics provided by
 * `@aquaculture/backend-common/metrics`.
 *
 * Label discipline (OBS-HIGH-001): NONE of these series carry a tenant
 * label. The /metrics scrape surface is unauthenticated, so a raw (or even
 * truncated) tenant id would both explode cardinality and let any scraper
 * enumerate active tenants. The emit methods still accept `tenantId` for
 * forward-compatibility (a bounded plan_tier dimension may land in B2) but
 * never put it on a series. Per-tenant abuse detection is a logs/traces
 * concern, not a metric label.
 *
 * Metrics exposed:
 *
 *   farm_mutation_duration_seconds  (histogram)
 *     Wall-clock duration of each GraphQL mutation. Labels: operation,
 *     outcome (`success` / `error`).
 *
 *   farm_mutation_errors_total      (counter)
 *     Mutation failures. Labels: operation, error_class
 *     (BadRequestException, ConflictException, GraphQLError, …).
 *
 *   farm_capacity_block_total       (counter)
 *     TankCapacityService rejections. Labels: mode
 *     (hard / admin-override / soft), axis (biomass / density / status).
 *
 *   farm_withdrawal_block_total     (counter)
 *     BatchHarvestEligibilityService rejections on closeBatch /
 *     createHarvestRecord / createHarvestPlan when an active
 *     medicine withdrawal period still covers the batch. Labels: surface.
 *
 *   farm_backdate_rejected_total    (counter)
 *     BackdatePolicyService rejections. Labels: context
 *     (feeding / growth / mortality / harvest).
 *
 *   farm_setup_legacy_write_total   (counter)
 *   farm_setup_legacy_read_total    (counter)
 *     Runtime baseline for the /sites/setup remediation. Labels:
 *     surface, operation, contract. Zero-use evidence for legacy setup
 *     API removal gates.
 *
 * Phase 5.3 of the "Farm modülü kalan kör noktalar" plan. Closes
 * Girdi 14d.
 */
import { ServiceMetricsService } from '@aquaculture/backend-common/metrics';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as client from 'prom-client';

export type MutationOutcome = 'success' | 'error';
export type CapacityBlockMode = 'hard' | 'admin_override' | 'soft';
export type CapacityBlockAxis = 'biomass' | 'density' | 'status';
export type WithdrawalBlockSurface = 'close_batch' | 'harvest_record' | 'harvest_plan';
export type BackdateContext = 'feeding' | 'growth' | 'mortality' | 'harvest';
export type SetupLegacyContract = 'graphql' | 'rest_upload' | 'path_document' | 'document_id';

@Injectable()
export class FarmDomainMetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FarmDomainMetricsService.name);
  private readonly registry: client.Registry;

  private mutationDuration!: client.Histogram;
  private mutationErrors!: client.Counter;
  private capacityBlocks!: client.Counter;
  private withdrawalBlocks!: client.Counter;
  private backdateRejections!: client.Counter;
  private setupLegacyWrites!: client.Counter;
  private setupLegacyReads!: client.Counter;
  private waterTemperatureReadFailures!: client.Counter;

  constructor() {
    this.registry = new client.Registry();
  }

  onModuleInit(): void {
    this.initializeMetrics();
    this.logger.log('Farm domain metrics initialized');
  }

  onModuleDestroy(): void {
    this.registry.clear();
    this.logger.log('Farm domain metrics cleaned up');
  }

  /** Returns the Prometheus-formatted metric dump for the /metrics endpoint. */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }

  /**
   * Surface this private registry through the platform scrape endpoint.
   *
   * WHY: until OBS-HIGH-001 this registry had a getMetrics() dump but NO
   * controller serving it — every farm_* counter was recorded and then
   * unreachable by Prometheus. The platform ServiceMetricsModule owns the
   * single GET /metrics endpoint; domain registries plug into it via
   * registerContributor instead of mounting a second controller on the
   * same route.
   *
   * WHAT: hands the aggregator a live reference (not a merge snapshot), so
   * metrics initialized in onModuleInit are visible regardless of hook
   * ordering. Called by FarmMetricsModule.onModuleInit.
   */
  contributeTo(serviceMetrics: ServiceMetricsService): void {
    serviceMetrics.registerContributor('farm-domain', this.registry);
  }

  recordMutation(params: {
    operation: string;
    durationSeconds: number;
    outcome: MutationOutcome;
    tenantId?: string;
  }): void {
    // OBS-HIGH-001: tenantId is accepted for forward-compat (a bounded
    // plan_tier dimension may land in B2) but NOT emitted as a label — a
    // raw/truncated tenant id on a scrape series enables tenant enumeration
    // and unbounded cardinality.
    this.mutationDuration.observe(
      {
        operation: params.operation,
        outcome: params.outcome,
      },
      params.durationSeconds,
    );
  }

  recordMutationError(params: { operation: string; errorClass: string; tenantId?: string }): void {
    this.mutationErrors.inc({
      operation: params.operation,
      error_class: params.errorClass,
    });
  }

  incCapacityBlock(params: {
    tenantId?: string;
    mode: CapacityBlockMode;
    axis: CapacityBlockAxis;
  }): void {
    this.capacityBlocks.inc({
      mode: params.mode,
      axis: params.axis,
    });
  }

  incWithdrawalBlock(params: { tenantId?: string; surface: WithdrawalBlockSurface }): void {
    this.withdrawalBlocks.inc({
      surface: params.surface,
    });
  }

  incBackdateRejection(params: { tenantId?: string; context: BackdateContext }): void {
    this.backdateRejections.inc({
      context: params.context,
    });
  }

  recordSetupLegacyWrite(params: {
    surface: string;
    operation: string;
    contract: SetupLegacyContract;
    tenantId?: string;
  }): void {
    this.setupLegacyWrites.inc({
      surface: params.surface,
      operation: params.operation,
      contract: params.contract,
    });
  }

  recordSetupLegacyRead(params: {
    surface: string;
    operation: string;
    contract: SetupLegacyContract;
    tenantId?: string;
  }): void {
    this.setupLegacyReads.inc({
      surface: params.surface,
      operation: params.operation,
      contract: params.contract,
    });
  }

  private initializeMetrics(): void {
    this.mutationDuration = new client.Histogram({
      name: 'farm_mutation_duration_seconds',
      help: 'Duration of farm-service GraphQL mutations in seconds',
      labelNames: ['operation', 'outcome'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.mutationErrors = new client.Counter({
      name: 'farm_mutation_errors_total',
      help: 'Total number of farm-service mutation failures by error class',
      labelNames: ['operation', 'error_class'],
      registers: [this.registry],
    });

    this.capacityBlocks = new client.Counter({
      name: 'farm_capacity_block_total',
      help: 'TankCapacityService rejections by mode and failing axis',
      labelNames: ['mode', 'axis'],
      registers: [this.registry],
    });

    this.withdrawalBlocks = new client.Counter({
      name: 'farm_withdrawal_block_total',
      help: 'Active medicine-withdrawal-period rejections by entry surface',
      labelNames: ['surface'],
      registers: [this.registry],
    });

    this.backdateRejections = new client.Counter({
      name: 'farm_backdate_rejected_total',
      help: 'BackdatePolicyService rejections by domain context',
      labelNames: ['context'],
      registers: [this.registry],
    });

    this.setupLegacyWrites = new client.Counter({
      name: 'farm_setup_legacy_write_total',
      help: 'Runtime baseline count for legacy setup GraphQL/REST write usage before SSOT cutover',
      labelNames: ['surface', 'operation', 'contract'],
      registers: [this.registry],
    });

    this.setupLegacyReads = new client.Counter({
      name: 'farm_setup_legacy_read_total',
      help: 'Runtime baseline count for legacy setup GraphQL/REST read usage before SSOT cutover',
      labelNames: ['surface', 'operation', 'contract'],
      registers: [this.registry],
    });

    // 2026-07-06 incident: a temperature-source infrastructure failure (the
    // live case: missing grant on sensor_temperature_latest) used to abort
    // batchMetrics and daily feeding wholesale. The WaterTemperatureService
    // bulkhead degrades the failed source to null — this counter is the LOUD
    // half of that degradation (alert on rate > 0).
    this.waterTemperatureReadFailures = new client.Counter({
      name: 'farm_water_temperature_read_failures_total',
      help: 'WaterTemperatureService per-source read failures degraded to null by the bulkhead',
      labelNames: ['source'],
      registers: [this.registry],
    });
  }

  /** One temperature source failed and was degraded to null by the bulkhead. */
  recordWaterTemperatureReadFailure(params: { source: 'sensor' | 'manual' }): void {
    this.waterTemperatureReadFailures.inc({ source: params.source });
  }

}
