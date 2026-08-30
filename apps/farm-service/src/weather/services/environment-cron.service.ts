import {
  listActiveTenantSchemaIdentities,
  listRetainedTenantSchemaIdentities,
  type TenantSchemaIdentity,
} from '@aquaculture/backend-common/database';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';

import {
  EnvironmentCronOutcome,
  FarmDomainMetricsService,
} from '../../common/metrics/farm-domain-metrics.service';
import { EnvironmentMonitoringGate } from './environment-monitoring-gate.service';
import { EnvironmentIngestionService, runBounded } from './environment-ingestion.service';
import {
  EnvironmentRetentionResult,
  EnvironmentSyncLease,
  EnvironmentSyncStore,
} from './environment-sync-store.service';
import { CMEMS_MAX_OUTBOUND_CONCURRENCY, CMEMS_REQUEST_TIMEOUT_MS } from './cmems-provider';

export const ENVIRONMENT_PROVIDER_CONCURRENCY = 4;
export const ENVIRONMENT_CLAIM_BATCH_SIZE = ENVIRONMENT_PROVIDER_CONCURRENCY;
const CMEMS_QUERY_PLANS_PER_HORIZON = 8;
const CMEMS_DISCOVERY_REQUESTS_PER_LEASE = 11;
const CMEMS_MAX_REQUEST_ATTEMPTS = 2;
const CMEMS_HORIZONS_PER_LEASE = 15;
const LEASE_SAFETY_MARGIN_MS = 5 * 60 * 1_000;
export const ENVIRONMENT_MAX_PROVIDER_EXECUTION_MS =
  Math.ceil(
    ((CMEMS_HORIZONS_PER_LEASE * CMEMS_QUERY_PLANS_PER_HORIZON +
      CMEMS_DISCOVERY_REQUESTS_PER_LEASE) *
      CMEMS_MAX_REQUEST_ATTEMPTS *
      ENVIRONMENT_PROVIDER_CONCURRENCY) /
      CMEMS_MAX_OUTBOUND_CONCURRENCY,
  ) *
    CMEMS_REQUEST_TIMEOUT_MS +
  LEASE_SAFETY_MARGIN_MS;
export const ENVIRONMENT_LEASE_DURATION_MS = ENVIRONMENT_MAX_PROVIDER_EXECUTION_MS;
const RETENTION_DAYS = 45;
const DAY_MS = 24 * 60 * 60 * 1_000;

@Injectable()
export class EnvironmentCronService {
  private readonly logger = new Logger(EnvironmentCronService.name);
  private rotation = 0;

  constructor(
    private readonly dataSource: DataSource,
    private readonly gate: EnvironmentMonitoringGate,
    private readonly store: EnvironmentSyncStore,
    private readonly ingestion: EnvironmentIngestionService,
    private readonly metrics: FarmDomainMetricsService,
  ) {}

  @Cron('*/15 * * * *', {
    name: 'environmentProviderSync',
    timeZone: 'UTC',
    waitForCompletion: true,
  })
  async syncDueProviders(): Promise<void> {
    const startedAt = Date.now();
    if (!this.gate.isEnabled()) {
      this.metrics.recordEnvironmentCronRun({
        job: 'provider_sync',
        outcome: 'disabled',
        durationSeconds: elapsedSeconds(startedAt),
      });
      return;
    }

    this.metrics.recordEnvironmentCronHeartbeat('provider_sync');
    let outcome: EnvironmentCronOutcome = 'success';
    try {
      let tenants: TenantSchemaIdentity[];
      try {
        tenants = rotate(await listActiveTenantSchemaIdentities(this.dataSource), this.rotation);
      } catch (error) {
        this.metrics.recordEnvironmentInternalFailure('tenant_discovery');
        throw error;
      }
      this.rotation += 1;
      let partialFailure = false;
      let processed = 0;
      let committed = 0;
      if (tenants.length > 0) {
        const sweepCutoff = new Date();
        const reconciliation = await this.reconcileTenantSweeps(tenants, sweepCutoff);
        partialFailure = reconciliation.failed;
        if (reconciliation.tenants.length > 0) {
          partialFailure = (await this.observeDueBacklog(reconciliation.tenants)) || partialFailure;
          const drain = await this.drainDueLeases(reconciliation.tenants, sweepCutoff);
          processed = drain.processed;
          committed = drain.committed;
          partialFailure = drain.failed || partialFailure;
          partialFailure = (await this.observeDueBacklog(reconciliation.tenants)) || partialFailure;
        }
      }
      outcome = partialFailure ? 'partial_failure' : 'success';
      this.logger.log({
        message: 'Environmental sync run completed',
        processed,
        committed,
        outcome,
      });
    } catch (error) {
      outcome = 'error';
      this.logger.error({
        message: 'Environmental sync run aborted',
        phase: 'tenant_discovery',
      });
      throw error;
    } finally {
      this.metrics.recordEnvironmentCronRun({
        job: 'provider_sync',
        outcome,
        durationSeconds: elapsedSeconds(startedAt),
      });
    }
  }

  @Cron('0 3 * * *', {
    name: 'environmentObservationRetention',
    timeZone: 'UTC',
    waitForCompletion: true,
  })
  async retainCanonicalObservations(): Promise<void> {
    const startedAt = Date.now();
    this.metrics.recordEnvironmentCronHeartbeat('retention');
    let outcome: EnvironmentCronOutcome = 'success';
    try {
      const cutoff = new Date(Date.now() - RETENTION_DAYS * DAY_MS);
      let tenants: TenantSchemaIdentity[];
      try {
        tenants = await listRetainedTenantSchemaIdentities(this.dataSource);
      } catch (error) {
        this.metrics.recordEnvironmentInternalFailure('tenant_discovery');
        throw error;
      }
      let partialFailure = false;
      const results = await runBounded(
        tenants,
        ENVIRONMENT_PROVIDER_CONCURRENCY,
        async (tenant) => {
          try {
            return await this.store.retainSchema(tenant.schemaName, tenant.tenantId, cutoff);
          } catch {
            partialFailure = true;
            this.metrics.recordEnvironmentInternalFailure('retention');
            this.logger.error({
              message: 'Environmental retention failed',
              phase: 'retention',
            });
            return emptyRetentionResult();
          } finally {
            this.metrics.recordEnvironmentCronHeartbeat('retention');
          }
        },
      );
      const totals = results.reduce<EnvironmentRetentionResult>(
        (total, result) => ({
          weatherDeleted: total.weatherDeleted + result.weatherDeleted,
          marineDeleted: total.marineDeleted + result.marineDeleted,
          scenesDeleted: total.scenesDeleted + result.scenesDeleted,
          obsoleteStatesDeleted: total.obsoleteStatesDeleted + result.obsoleteStatesDeleted,
        }),
        emptyRetentionResult(),
      );
      this.metrics.recordEnvironmentRetentionDeleted({
        kind: 'weather',
        count: totals.weatherDeleted,
      });
      this.metrics.recordEnvironmentRetentionDeleted({
        kind: 'marine',
        count: totals.marineDeleted,
      });
      this.metrics.recordEnvironmentRetentionDeleted({
        kind: 'scene',
        count: totals.scenesDeleted,
      });
      this.metrics.recordEnvironmentRetentionDeleted({
        kind: 'obsolete_sync_state',
        count: totals.obsoleteStatesDeleted,
      });
      outcome = partialFailure ? 'partial_failure' : 'success';
      this.logger.log({
        message: 'Environmental retention run completed',
        weatherDeleted: totals.weatherDeleted,
        marineDeleted: totals.marineDeleted,
        scenesDeleted: totals.scenesDeleted,
        obsoleteStatesDeleted: totals.obsoleteStatesDeleted,
        outcome,
      });
    } catch (error) {
      outcome = 'error';
      this.logger.error({
        message: 'Environmental retention run aborted',
        phase: 'tenant_discovery',
      });
      throw error;
    } finally {
      this.metrics.recordEnvironmentCronRun({
        job: 'retention',
        outcome,
        durationSeconds: elapsedSeconds(startedAt),
      });
    }
  }

  private async observeDueBacklog(tenants: readonly TenantSchemaIdentity[]): Promise<boolean> {
    const measuredAt = new Date();
    let failed = false;
    const measurements = await runBounded(
      tenants,
      ENVIRONMENT_PROVIDER_CONCURRENCY,
      async (tenant) => {
        try {
          return await this.store.measureDueBacklog(tenant.schemaName, tenant.tenantId, measuredAt);
        } catch {
          failed = true;
          this.metrics.recordEnvironmentInternalFailure('backlog_measurement');
          this.logger.error({
            message: 'Environmental due backlog measurement failed',
            phase: 'backlog_measurement',
          });
          return null;
        }
      },
    );
    // A missing tenant is unknown, not zero. Publishing a partial aggregate
    // would make an unavailable (and potentially badly backlogged) tenant
    // disappear from the global gauge. Preserve the last complete sample and
    // let the internal-failure counter + partial cron outcome signal staleness.
    if (failed) {
      return true;
    }
    const completeMeasurements = measurements.filter(
      (measurement): measurement is NonNullable<typeof measurement> => measurement !== null,
    );
    const dueCount = completeMeasurements.reduce(
      (sum, measurement) => sum + measurement.dueCount,
      0,
    );
    const oldestDueAt = completeMeasurements.reduce<Date | null>((oldest, measurement) => {
      if (!measurement.oldestDueAt) return oldest;
      if (!oldest || measurement.oldestDueAt.getTime() < oldest.getTime()) {
        return measurement.oldestDueAt;
      }
      return oldest;
    }, null);
    this.metrics.setEnvironmentDueBacklog({
      dueCount,
      oldestDueAgeSeconds: oldestDueAt
        ? Math.max(0, (measuredAt.getTime() - oldestDueAt.getTime()) / 1_000)
        : 0,
    });
    return false;
  }

  private async reconcileTenantSweeps(
    tenants: readonly TenantSchemaIdentity[],
    reconciledAt: Date,
  ): Promise<{ tenants: TenantSchemaIdentity[]; failed: boolean }> {
    const results = await runBounded(
      tenants,
      ENVIRONMENT_PROVIDER_CONCURRENCY,
      async (tenant): Promise<TenantSchemaIdentity | null> => {
        try {
          await this.store.reconcileSyncStates(tenant.schemaName, tenant.tenantId, reconciledAt);
          return tenant;
        } catch {
          this.metrics.recordEnvironmentInternalFailure('state_reconciliation');
          this.logger.error({
            message: 'Environmental sync-state reconciliation failed',
            phase: 'state_reconciliation',
          });
          return null;
        }
      },
    );
    const reconciledTenants: TenantSchemaIdentity[] = [];
    let failed = false;
    for (const result of results) {
      if (result) {
        reconciledTenants.push(result);
      } else {
        failed = true;
      }
    }
    return { tenants: reconciledTenants, failed };
  }

  private async drainDueLeases(
    tenants: readonly TenantSchemaIdentity[],
    dueCutoff: Date,
  ): Promise<{ processed: number; committed: number; failed: boolean }> {
    const tenantQueue = [...tenants];
    let processed = 0;
    let committed = 0;
    let failed = false;

    while (tenantQueue.length > 0) {
      const tenant = tenantQueue.shift()!;
      let leases: EnvironmentSyncLease[];
      try {
        leases = await this.store.claimDue(
          tenant.schemaName,
          tenant.tenantId,
          dueCutoff,
          new Date(),
          ENVIRONMENT_CLAIM_BATCH_SIZE,
          ENVIRONMENT_LEASE_DURATION_MS,
        );
      } catch {
        failed = true;
        this.metrics.recordEnvironmentInternalFailure('claim');
        this.logger.error({
          message: 'Environmental lease discovery failed',
          phase: 'claim',
        });
        continue;
      }

      if (leases.length === 0) {
        continue;
      }
      tenantQueue.push(tenant);
      processed += leases.length;
      const outcomes = await runBounded(
        leases,
        ENVIRONMENT_PROVIDER_CONCURRENCY,
        async (lease): Promise<{ committed: boolean; failed: boolean }> => {
          try {
            return {
              committed: await this.ingestion.processLease(lease),
              failed: false,
            };
          } catch {
            this.metrics.recordEnvironmentInternalFailure('lease_execution');
            this.logger.error({
              message: 'Environmental provider lease failed before completion',
              phase: 'lease_execution',
              provider: lease.provider,
            });
            return { committed: false, failed: true };
          } finally {
            this.metrics.recordEnvironmentCronHeartbeat('provider_sync');
          }
        },
      );
      for (const result of outcomes) {
        if (result.committed) committed += 1;
        if (result.failed) failed = true;
      }
    }

    return { processed, committed, failed };
  }
}

function rotate<T>(values: readonly T[], by: number): T[] {
  if (values.length === 0) return [];
  const offset = by % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

function emptyRetentionResult(): EnvironmentRetentionResult {
  return {
    weatherDeleted: 0,
    marineDeleted: 0,
    scenesDeleted: 0,
    obsoleteStatesDeleted: 0,
  };
}

function elapsedSeconds(startedAt: number): number {
  return Math.max(0, (Date.now() - startedAt) / 1_000);
}
