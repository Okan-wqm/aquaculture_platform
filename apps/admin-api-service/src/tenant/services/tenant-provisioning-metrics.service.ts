import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  type MetricsContributorRegistry,
  ServiceMetricsService,
} from '@aquaculture/backend-common/metrics';
import * as client from 'prom-client';

export interface TelemetryCapacityMetricsSnapshot {
  ingressUtilizationRatio: number;
  rowUtilizationRatio: number;
  pendingReservations: number;
  oldestPendingAgeSeconds: number;
  oldestOutboxAgeSeconds: number;
}

/**
 * The provisioning saga's outside surface.
 *
 * WHY THIS EXISTS. Tenant onboarding was broken in production for months and
 * nobody was told. Every run failed at step zero on an RLS refusal, the run row
 * recorded `FAILED` with an accurate `lastError`, and that was the end of it:
 * admin-api exported not one counter or gauge about provisioning, so the only
 * way to learn that no tenant could be created was for a human to try creating
 * one. Two tenants sat unusable — one of them ACTIVE, which reads as healthy in
 * the admin panel — until somebody went looking.
 *
 * WHAT IT MEASURES, and why each one:
 *
 *   - `tenant_provisioning_runs_total{state}` — terminal outcomes. A rising
 *     FAILED is the alarm; a flat SUCCEEDED next to a rising FAILED is the
 *     shape this outage had.
 *   - `tenant_provisioning_step_failures_total{step}` — WHICH of the eight
 *     steps refuses. The RLS defect always died on `reserve_auth_tenant`, so
 *     this label alone would have named the culprit on day one.
 *   - `tenant_provisioning_step_duration_seconds{step,outcome}` — a step that
 *     starts taking minutes is the precursor to the lease expiring and the run
 *     being retried forever.
 *   - `tenant_provisioning_active_runs` / `..._oldest_active_run_age_seconds` —
 *     the stuck case. Production currently holds two runs in RUNNING with
 *     `attempts=3` and no lease; nothing counts them, so nothing can say how
 *     long they have been there.
 *
 * The gauges are refreshed from the queue sweeper that already runs every ten
 * seconds rather than a new scheduled job — a metric surface that needs its own
 * scheduler is one more thing that can silently stop.
 */
@Injectable()
export class TenantProvisioningMetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TenantProvisioningMetricsService.name);
  private readonly registry: client.Registry;

  private readonly runs: client.Counter<'state'>;
  private readonly stepFailures: client.Counter<'step'>;
  private readonly stepDuration: client.Histogram<'step' | 'outcome'>;
  private readonly activeRuns: client.Gauge<string>;
  private readonly oldestActiveRunAge: client.Gauge<string>;
  private readonly capacityUtilization: client.Gauge<'dimension'>;
  private readonly pendingCapacityReservations: client.Gauge<string>;
  private readonly oldestPendingCapacityAge: client.Gauge<string>;
  private readonly oldestCapacityOutboxAge: client.Gauge<string>;

  constructor(
    // Injected by class token, typed by the narrow contract this service
    // actually uses — so a test can supply a real object rather than a cast
    // of a mock, and the banned-construct gate stays satisfied honestly.
    @Inject(ServiceMetricsService)
    private readonly serviceMetrics: MetricsContributorRegistry,
  ) {
    this.registry = new client.Registry();

    this.runs = new client.Counter({
      name: 'tenant_provisioning_runs_total',
      help: 'Tenant provisioning runs that reached a terminal state',
      labelNames: ['state'],
      registers: [this.registry],
    });
    this.stepFailures = new client.Counter({
      name: 'tenant_provisioning_step_failures_total',
      help: 'Provisioning step failures by step name',
      labelNames: ['step'],
      registers: [this.registry],
    });
    this.stepDuration = new client.Histogram({
      name: 'tenant_provisioning_step_duration_seconds',
      help: 'Wall-clock duration of each provisioning step by outcome',
      labelNames: ['step', 'outcome'],
      buckets: [0.5, 1, 5, 15, 30, 60, 120, 300],
      registers: [this.registry],
    });
    this.activeRuns = new client.Gauge({
      name: 'tenant_provisioning_active_runs',
      help: 'Provisioning runs currently QUEUED or RUNNING',
      registers: [this.registry],
    });
    this.oldestActiveRunAge = new client.Gauge({
      name: 'tenant_provisioning_oldest_active_run_age_seconds',
      help: 'Age of the oldest provisioning run that has not reached a terminal state',
      registers: [this.registry],
    });
    this.capacityUtilization = new client.Gauge({
      name: 'telemetry_capacity_envelope_utilization_ratio',
      help: 'Committed telemetry capacity divided by the active envelope, by M/R dimension',
      labelNames: ['dimension'],
      registers: [this.registry],
    });
    this.pendingCapacityReservations = new client.Gauge({
      name: 'telemetry_capacity_pending_reservations',
      help: 'Telemetry capacity entitlements whose latest activation state is PENDING_CAPACITY',
      registers: [this.registry],
    });
    this.oldestPendingCapacityAge = new client.Gauge({
      name: 'telemetry_capacity_oldest_pending_age_seconds',
      help: 'Age of the oldest telemetry capacity entitlement still pending admission',
      registers: [this.registry],
    });
    this.oldestCapacityOutboxAge = new client.Gauge({
      name: 'telemetry_capacity_oldest_outbox_age_seconds',
      help: 'Age of the oldest unpublished telemetry capacity entitlement outbox event',
      registers: [this.registry],
    });

    // Seed both gauges. A gauge that exports no series until the first
    // observation makes `> 900` match nothing, so the alert for "a run is
    // stuck" would be silent for exactly as long as nothing was observed.
    this.activeRuns.set(0);
    this.oldestActiveRunAge.set(0);
    this.recordTelemetryCapacity({
      ingressUtilizationRatio: 0,
      rowUtilizationRatio: 0,
      pendingReservations: 0,
      oldestPendingAgeSeconds: 0,
      oldestOutboxAgeSeconds: 0,
    });
  }

  onModuleInit(): void {
    this.serviceMetrics.registerContributor('tenant-provisioning', this.registry);
    this.logger.log('Tenant provisioning metrics registered');
  }

  onModuleDestroy(): void {
    this.registry.clear();
  }

  recordRunTerminal(state: string): void {
    this.runs.inc({ state });
  }

  recordStepOutcome(step: string, outcome: 'success' | 'failure', durationSeconds: number): void {
    this.stepDuration.observe({ step, outcome }, durationSeconds);
    if (outcome === 'failure') {
      this.stepFailures.inc({ step });
    }
  }

  /** Called by the queue sweeper with what it already had to read anyway. */
  recordActiveRuns(count: number, oldestAgeSeconds: number): void {
    this.activeRuns.set(count);
    this.oldestActiveRunAge.set(oldestAgeSeconds);
  }

  recordTelemetryCapacity(snapshot: TelemetryCapacityMetricsSnapshot): void {
    this.capacityUtilization.set(
      { dimension: 'ingress_messages_per_second' },
      snapshot.ingressUtilizationRatio,
    );
    this.capacityUtilization.set(
      { dimension: 'metric_rows_per_minute' },
      snapshot.rowUtilizationRatio,
    );
    this.pendingCapacityReservations.set(snapshot.pendingReservations);
    this.oldestPendingCapacityAge.set(snapshot.oldestPendingAgeSeconds);
    this.oldestCapacityOutboxAge.set(snapshot.oldestOutboxAgeSeconds);
  }

  /** Prometheus dump of this registry (tests + debugging). */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
