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
 * Metrics exposed:
 *
 *   farm_mutation_duration_seconds  (histogram)
 *     Wall-clock duration of each GraphQL mutation, labelled by
 *     operation name, and outcome
 *     (`success` / `error`).
 *
 *   farm_mutation_errors_total      (counter)
 *     Mutation failures, labelled by operation name + error class
 *     (BadRequestException, ConflictException, GraphQLError, …).
 *     Surfaces abuse patterns (one endpoint erroring 100x on a
 *     single tenant) and regressions (one class dominating across
 *     operations).
 *
 *   farm_capacity_block_total       (counter)
 *     TankCapacityService rejections. Labels: mode
 *     (hard / admin-override / soft), axis (biomass / density / status).
 *
 *   farm_withdrawal_block_total     (counter)
 *     BatchHarvestEligibilityService rejections on closeBatch /
 *     createHarvestRecord / createHarvestPlan when an active
 *     medicine withdrawal period still covers the batch. Labels:
 *     surface (close / harvest / plan).
 *
 *   farm_backdate_rejected_total    (counter)
 *     BackdatePolicyService rejections. Labels: context
 *     (feeding / growth / mortality / harvest).
 *
 * Phase 5.3 of the "Farm modülü kalan kör noktalar" plan. Closes
 * Girdi 14d.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as client from 'prom-client';

export type MutationOutcome = 'success' | 'error';
export type CapacityBlockMode = 'hard' | 'admin_override' | 'soft';
export type CapacityBlockAxis = 'biomass' | 'density' | 'status';
export type WithdrawalBlockSurface = 'close_batch' | 'harvest_record' | 'harvest_plan';
export type BackdateContext = 'feeding' | 'growth' | 'mortality' | 'harvest';

@Injectable()
export class FarmDomainMetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FarmDomainMetricsService.name);
  private readonly registry: client.Registry;

  private mutationDuration!: client.Histogram;
  private mutationErrors!: client.Counter;
  private capacityBlocks!: client.Counter;
  private withdrawalBlocks!: client.Counter;
  private backdateRejections!: client.Counter;

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

  recordMutation(params: {
    operation: string;
    durationSeconds: number;
    outcome: MutationOutcome;
    tenantId?: string;
  }): void {
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
  }
}
