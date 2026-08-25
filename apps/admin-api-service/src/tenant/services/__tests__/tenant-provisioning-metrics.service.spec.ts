/**
 * The provisioning saga failed in production for months and told nobody. These
 * pin the surface that would have said so — including the two properties that
 * decide whether an alert can fire at all: the step label that names WHICH
 * step refused, and the seeded gauges that make "stuck run" expressible before
 * anything has been observed.
 */
import type { MetricsContributorRegistry } from '@aquaculture/backend-common/metrics';

import { TenantProvisioningMetricsService } from '../tenant-provisioning-metrics.service';

describe('TenantProvisioningMetricsService', () => {
  let registered: Map<string, unknown>;
  let service: TenantProvisioningMetricsService;

  beforeEach(() => {
    registered = new Map();
    const serviceMetrics: MetricsContributorRegistry = {
      registerContributor: (name, registry) => {
        registered.set(name, registry);
      },
    };
    service = new TenantProvisioningMetricsService(serviceMetrics);
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('joins the service scrape endpoint instead of opening its own', async () => {
    // A second /metrics port is a second thing to forget to scrape.
    service.onModuleInit();

    expect(registered.has('tenant-provisioning')).toBe(true);
  });

  it('names the step that refused, which is the whole diagnostic value', async () => {
    // Every failed run in production died on reserve_auth_tenant. With only a
    // run-level counter the operator learns "provisioning is broken"; with the
    // step label they learn where to look.
    service.recordStepOutcome('reserve_auth_tenant', 'failure', 0.4);

    const dump = await service.getMetrics();

    expect(dump).toContain('tenant_provisioning_step_failures_total{step="reserve_auth_tenant"} 1');
    expect(dump).toContain('outcome="failure"');
  });

  it('does not count a successful step as a failure', async () => {
    service.recordStepOutcome('create_tenant_schema', 'success', 12);

    const dump = await service.getMetrics();

    expect(dump).not.toMatch(
      /tenant_provisioning_step_failures_total\{step="create_tenant_schema"\} [1-9]/,
    );
    expect(dump).toMatch(
      /tenant_provisioning_step_duration_seconds_sum\{[^}]*step="create_tenant_schema"[^}]*\} 12/,
    );
  });

  it('separates terminal outcomes so a flat SUCCEEDED beside a rising FAILED is visible', async () => {
    service.recordRunTerminal('FAILED');
    service.recordRunTerminal('FAILED');
    service.recordRunTerminal('SUCCEEDED');

    const dump = await service.getMetrics();

    expect(dump).toContain('tenant_provisioning_runs_total{state="FAILED"} 2');
    expect(dump).toContain('tenant_provisioning_runs_total{state="SUCCEEDED"} 1');
  });

  it('exports both gauges at zero before anything has been observed', async () => {
    // The bug this prevents: a gauge with no series makes `> 900` match
    // nothing, so "a run has been stuck for an hour" would be silent for
    // exactly as long as the process had seen no runs — which is the state a
    // wedged queue leaves behind after a restart.
    const dump = await service.getMetrics();

    expect(dump).toContain('tenant_provisioning_active_runs 0');
    expect(dump).toContain('tenant_provisioning_oldest_active_run_age_seconds 0');
  });

  it('reports the stuck shape production is in right now', async () => {
    // Two runs in RUNNING with attempts=3, oldest created weeks ago.
    service.recordActiveRuns(2, 1_209_600);

    const dump = await service.getMetrics();

    expect(dump).toContain('tenant_provisioning_active_runs 2');
    expect(dump).toContain('tenant_provisioning_oldest_active_run_age_seconds 1209600');
  });

  it('exports M/R envelope use and pending admission age separately', async () => {
    service.recordTelemetryCapacity({
      ingressUtilizationRatio: 0.7,
      rowUtilizationRatio: 0.5,
      pendingReservations: 3,
      oldestPendingAgeSeconds: 900,
      oldestOutboxAgeSeconds: 12,
    });

    const dump = await service.getMetrics();

    expect(dump).toContain(
      'telemetry_capacity_envelope_utilization_ratio{dimension="ingress_messages_per_second"} 0.7',
    );
    expect(dump).toContain(
      'telemetry_capacity_envelope_utilization_ratio{dimension="metric_rows_per_minute"} 0.5',
    );
    expect(dump).toContain('telemetry_capacity_pending_reservations 3');
    expect(dump).toContain('telemetry_capacity_oldest_pending_age_seconds 900');
    expect(dump).toContain('telemetry_capacity_oldest_outbox_age_seconds 12');
  });
});
