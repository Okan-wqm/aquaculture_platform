/**
 * FarmDomainMetricsService Unit Tests
 *
 * Exercises every counter / histogram exposed by the service and
 * confirms the Prometheus text output carries the expected label
 * sets. Uses a direct instantiation (no Nest DI) and calls
 * onModuleInit / onModuleDestroy manually so the tests are
 * independent of the module life-cycle.
 */
import { ServiceMetricsService } from '@aquaculture/backend-common/metrics';

import {
  EnvironmentProvider,
  EnvironmentSyncStatus,
} from '../../../weather/entities/environment-observation.types';
import { FarmDomainMetricsService } from '../farm-domain-metrics.service';

describe('FarmDomainMetricsService', () => {
  let service: FarmDomainMetricsService;

  beforeEach(() => {
    service = new FarmDomainMetricsService();
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('records mutation duration with operation + outcome labels (no tenant label)', async () => {
    service.recordMutation({
      operation: 'createBatch',
      durationSeconds: 0.12,
      outcome: 'success',
      tenantId: '11111111-1111-4111-8111-111111111111',
    });
    service.recordMutation({
      operation: 'createBatch',
      durationSeconds: 0.08,
      outcome: 'error',
      tenantId: '11111111-1111-4111-8111-111111111111',
    });
    const dump = await service.getMetrics();
    expect(dump).toContain('farm_mutation_duration_seconds_count');
    expect(dump).toContain('operation="createBatch"');
    expect(dump).toContain('outcome="success"');
    expect(dump).toContain('outcome="error"');
    // OBS-HIGH-001: tenantId is accepted by the API but MUST NOT appear as a
    // label (cardinality + tenant-enumeration hazard on the scrape surface).
    expect(dump).not.toContain('tenant=');
    expect(dump).not.toContain('11111111');
  });

  it('records mutation errors with classified error_class', async () => {
    service.recordMutationError({
      operation: 'closeBatch',
      errorClass: 'BadRequestException',
    });
    service.recordMutationError({
      operation: 'closeBatch',
      errorClass: 'BadRequestException',
    });
    service.recordMutationError({
      operation: 'createHarvestRecord',
      errorClass: 'ConflictException',
    });
    const dump = await service.getMetrics();
    expect(dump).toContain('farm_mutation_errors_total');
    expect(dump).toMatch(
      /farm_mutation_errors_total\{operation="closeBatch",error_class="BadRequestException"[^}]*} 2/,
    );
    expect(dump).toMatch(
      /farm_mutation_errors_total\{operation="createHarvestRecord",error_class="ConflictException"[^}]*} 1/,
    );
  });

  it('records capacity blocks with mode + axis', async () => {
    service.incCapacityBlock({ mode: 'hard', axis: 'biomass' });
    service.incCapacityBlock({
      mode: 'admin_override',
      axis: 'density',
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    const dump = await service.getMetrics();
    expect(dump).toContain('farm_capacity_block_total');
    expect(dump).toContain('mode="hard"');
    expect(dump).toContain('mode="admin_override"');
    expect(dump).toContain('axis="biomass"');
    expect(dump).toContain('axis="density"');
  });

  it('records withdrawal blocks by surface', async () => {
    service.incWithdrawalBlock({ surface: 'close_batch' });
    service.incWithdrawalBlock({ surface: 'harvest_record' });
    service.incWithdrawalBlock({ surface: 'harvest_record' });
    const dump = await service.getMetrics();
    expect(dump).toContain('farm_withdrawal_block_total');
    expect(dump).toMatch(/farm_withdrawal_block_total\{[^}]*surface="close_batch"[^}]*} 1/);
    expect(dump).toMatch(/farm_withdrawal_block_total\{[^}]*surface="harvest_record"[^}]*} 2/);
  });

  it('records backdate rejections by context', async () => {
    service.incBackdateRejection({ context: 'feeding' });
    service.incBackdateRejection({ context: 'mortality' });
    service.incBackdateRejection({ context: 'feeding' });
    const dump = await service.getMetrics();
    expect(dump).toContain('farm_backdate_rejected_total');
    expect(dump).toMatch(/farm_backdate_rejected_total\{[^}]*context="feeding"[^}]*} 2/);
    expect(dump).toMatch(/farm_backdate_rejected_total\{[^}]*context="mortality"[^}]*} 1/);
  });

  it('records setup legacy write and read usage for removal gates', async () => {
    service.recordSetupLegacyWrite({
      surface: 'site',
      operation: 'createSite',
      contract: 'graphql',
      tenantId: '22222222-2222-4222-8222-222222222222',
    });
    service.recordSetupLegacyRead({
      surface: 'farm_workers',
      operation: 'workers',
      contract: 'graphql',
      tenantId: '22222222-2222-4222-8222-222222222222',
    });

    const dump = await service.getMetrics();
    expect(dump).toContain('farm_setup_legacy_write_total');
    expect(dump).toContain('farm_setup_legacy_read_total');
    expect(dump).toMatch(
      /farm_setup_legacy_write_total\{surface="site",operation="createSite",contract="graphql"} 1/,
    );
    expect(dump).toMatch(
      /farm_setup_legacy_read_total\{surface="farm_workers",operation="workers",contract="graphql"} 1/,
    );
  });

  it('never emits a tenant label or any part of the tenant id (OBS-HIGH-001)', async () => {
    service.recordMutation({
      operation: 'cardinalityCheck',
      durationSeconds: 0.01,
      outcome: 'success',
      tenantId: 'abcdef12-3456-4789-8abc-def123456789',
    });
    const dump = await service.getMetrics();
    // No tenant label, and no truncated prefix either — an 8-char prefix is
    // still 1 series per distinct tenant (enumeration), so it is forbidden.
    expect(dump).not.toContain('tenant=');
    expect(dump).not.toContain('abcdef12');
  });

  it('records regulatory submission outcomes by report_type + outcome, no tenant label (OBS-HIGH-001)', async () => {
    service.incRegulatorySubmission({
      reportType: 'SEA_LICE',
      outcome: 'submitted',
      tenantId: '11111111-1111-4111-8111-111111111111',
    });
    service.incRegulatorySubmission({ reportType: 'SMOLT', outcome: 'failed' });
    service.incRegulatorySubmission({ reportType: 'ESCAPE', outcome: 'queued' });

    const dump = await service.getMetrics();
    expect(dump).toContain('farm_regulatory_submission_total');
    expect(dump).toContain('report_type="SEA_LICE",outcome="submitted"');
    expect(dump).toContain('report_type="SMOLT",outcome="failed"');
    expect(dump).toContain('report_type="ESCAPE",outcome="queued"');
    // Label discipline: no tenant on the series.
    expect(dump).not.toContain('11111111');
  });

  it('records regulatory cron runs + a heartbeat gauge by job + outcome (OBS-HIGH-002)', async () => {
    service.recordRegulatoryCronRun({ job: 'regulatory-retry-sweep', outcome: 'success' });
    service.recordRegulatoryCronRun({
      job: 'regulatory-deadline-sweep',
      outcome: 'skipped_locked',
    });

    const dump = await service.getMetrics();
    expect(dump).toContain('farm_regulatory_cron_runs_total');
    expect(dump).toContain('job="regulatory-retry-sweep",outcome="success"');
    expect(dump).toContain('job="regulatory-deadline-sweep",outcome="skipped_locked"');
    // The heartbeat gauge carries a fresh unix timestamp per job.
    expect(dump).toContain('farm_regulatory_cron_last_run_timestamp_seconds');
    expect(dump).toMatch(
      /farm_regulatory_cron_last_run_timestamp_seconds\{job="regulatory-retry-sweep"\}\s+\d/,
    );
  });

  it('exposes the environment rollout gate and bounded cron heartbeat outcomes', async () => {
    service.setEnvironmentMonitoringEnabled(true);
    service.recordEnvironmentCronRun({
      job: 'provider_sync',
      outcome: 'success',
      durationSeconds: 2.5,
    });
    service.recordEnvironmentCronRun({
      job: 'retention',
      outcome: 'partial_failure',
      durationSeconds: 4,
    });

    const dump = await service.getMetrics();
    expect(dump).toContain('farm_environment_monitoring_enabled 1');
    expect(dump).toContain(
      'farm_environment_cron_runs_total{job="provider_sync",outcome="success"} 1',
    );
    expect(dump).toContain(
      'farm_environment_cron_runs_total{job="retention",outcome="partial_failure"} 1',
    );
    expect(dump).toMatch(
      /farm_environment_cron_last_success_timestamp_seconds\{job="provider_sync"\}\s+[1-9]/,
    );
    expect(dump).toMatch(
      /farm_environment_cron_last_failure_timestamp_seconds\{job="retention"\}\s+[1-9]/,
    );
    expect(dump).toContain('farm_environment_cron_run_duration_seconds_count');
  });

  it('records provider status, last success/failure, lease discard and internal phase without tenant labels', async () => {
    service.recordEnvironmentProviderCompletion({
      provider: EnvironmentProvider.MET_LOCATIONFORECAST,
      status: EnvironmentSyncStatus.READY,
      successfulProviderResponse: true,
      scopeOutcomes: [],
    });
    service.recordEnvironmentProviderCompletion({
      provider: EnvironmentProvider.CDSE_SENTINEL_2,
      status: EnvironmentSyncStatus.CONFIGURATION_ERROR,
      successfulProviderResponse: false,
      scopeOutcomes: [],
    });
    service.recordEnvironmentLeaseDiscard(EnvironmentProvider.CMEMS);
    service.recordEnvironmentInternalFailure('claim');

    const dump = await service.getMetrics();
    expect(dump).toContain(
      'farm_environment_provider_completions_total{provider="MET_LOCATIONFORECAST",status="READY"} 1',
    );
    expect(dump).toContain(
      'farm_environment_provider_completions_total{provider="CDSE_SENTINEL_2",status="CONFIGURATION_ERROR"} 1',
    );
    expect(dump).toMatch(
      /farm_environment_provider_last_success_timestamp_seconds\{provider="MET_LOCATIONFORECAST"\}\s+[1-9]/,
    );
    expect(dump).toMatch(
      /farm_environment_provider_last_failure_timestamp_seconds\{provider="CDSE_SENTINEL_2"\}\s+[1-9]/,
    );
    expect(dump).toContain('farm_environment_lease_discarded_total{provider="CMEMS"} 1');
    expect(dump).toContain('farm_environment_internal_failures_total{phase="claim"} 1');
    expect(dump).not.toContain('tenant=');
    expect(dump).not.toContain('site=');
  });

  it('records retention totals and rejects invalid counter increments', async () => {
    service.recordEnvironmentRetentionDeleted({ kind: 'weather', count: 7 });
    service.recordEnvironmentRetentionDeleted({
      kind: 'obsolete_sync_state',
      count: 2,
    });

    expect(() => service.recordEnvironmentRetentionDeleted({ kind: 'scene', count: -1 })).toThrow(
      'environment retention metric count must be a non-negative integer',
    );

    const dump = await service.getMetrics();
    expect(dump).toContain('farm_environment_retention_deleted_total{kind="weather"} 7');
    expect(dump).toContain(
      'farm_environment_retention_deleted_total{kind="obsolete_sync_state"} 2',
    );
  });

  it('initializes backlog gauges at startup and mutation errors never re-register them', async () => {
    service.setEnvironmentDueBacklog({ dueCount: 3, oldestDueAgeSeconds: 90 });
    service.recordMutationError({ operation: 'one', errorClass: 'BadRequestException' });
    service.recordMutationError({ operation: 'two', errorClass: 'ConflictException' });

    const dump = await service.getMetrics();
    expect(dump).toContain('farm_environment_due_backlog 3');
    expect(dump).toContain('farm_environment_oldest_due_age_seconds 90');
  });

  it('exposes the correct Prometheus content-type', () => {
    expect(service.getContentType()).toMatch(/^text\/plain/);
  });

  it('surfaces the domain registry on the platform /metrics output via contributeTo (OBS-HIGH-001)', async () => {
    // WHY: pre-fix the farm domain registry had a getMetrics() dump but no
    // controller serving it — Prometheus could never scrape farm_* series.
    // contributeTo() plugs the registry into the platform scrape endpoint;
    // this test proves the wiring end-to-end at the service level.
    const platformMetrics = new ServiceMetricsService();
    platformMetrics.onModuleInit();

    service.recordMutation({
      operation: 'contributeCheck',
      durationSeconds: 0.02,
      outcome: 'success',
      tenantId: '33333333-3333-4333-8333-333333333333',
    });
    service.contributeTo(platformMetrics);

    const scrape = await platformMetrics.getMetrics();
    // Platform HTTP families AND farm domain families share ONE document.
    expect(scrape).toContain('http_requests_total');
    expect(scrape).toContain('farm_mutation_duration_seconds');
    expect(scrape).toContain('operation="contributeCheck"');

    platformMetrics.onModuleDestroy();
  });
});
