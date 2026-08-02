import { DataSource } from 'typeorm';

import { FarmDomainMetricsService } from '../../common/metrics/farm-domain-metrics.service';
import {
  ENVIRONMENT_CLAIM_BATCH_SIZE,
  ENVIRONMENT_LEASE_DURATION_MS,
  ENVIRONMENT_MAX_PROVIDER_EXECUTION_MS,
  ENVIRONMENT_PROVIDER_CONCURRENCY,
  EnvironmentCronService,
} from './environment-cron.service';
import { EnvironmentIngestionService } from './environment-ingestion.service';
import { EnvironmentMonitoringGate } from './environment-monitoring-gate.service';
import { EnvironmentProvider } from '../entities/environment-observation.types';
import { EnvironmentSyncLease, EnvironmentSyncStore } from './environment-sync-store.service';
import { DEFAULT_CMEMS_CACHE_POLICY } from './cmems-provider';

const NOW = new Date('2026-07-31T04:00:00.000Z');
const TENANT_A = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = '22222222-2222-4222-8222-bbbbbbbbbbbb';
const SCHEMA_A = 'tenant_1111111111114111';
const SCHEMA_B = 'tenant_2222222222224222';

interface MetricsHarness {
  service: FarmDomainMetricsService;
  recordCronRun: jest.Mock;
  recordInternalFailure: jest.Mock;
  recordRetentionDeleted: jest.Mock;
  recordHeartbeat: jest.Mock;
  setDueBacklog: jest.Mock;
}

function metricsHarness(): MetricsHarness {
  const service: FarmDomainMetricsService = Object.create(FarmDomainMetricsService.prototype);
  const recordCronRun = jest.fn();
  const recordInternalFailure = jest.fn();
  const recordRetentionDeleted = jest.fn();
  const recordHeartbeat = jest.fn();
  const setDueBacklog = jest.fn();
  service.recordEnvironmentCronRun = recordCronRun;
  service.recordEnvironmentInternalFailure = recordInternalFailure;
  service.recordEnvironmentRetentionDeleted = recordRetentionDeleted;
  service.recordEnvironmentCronHeartbeat = recordHeartbeat;
  service.setEnvironmentDueBacklog = setDueBacklog;
  return {
    service,
    recordCronRun,
    recordInternalFailure,
    recordRetentionDeleted,
    recordHeartbeat,
    setDueBacklog,
  };
}

describe('EnvironmentCronService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('disables ingestion but still runs lifecycle retention while the rollout gate is false', async () => {
    const dataSource: DataSource = Object.create(DataSource.prototype);
    dataSource.query = jest.fn().mockResolvedValue([]);
    const gate: EnvironmentMonitoringGate = Object.create(EnvironmentMonitoringGate.prototype);
    gate.isEnabled = jest.fn().mockReturnValue(false);
    const store: EnvironmentSyncStore = Object.create(EnvironmentSyncStore.prototype);
    store.reconcileSyncStates = jest.fn();
    store.claimDue = jest.fn();
    store.retainSchema = jest.fn();
    const ingestion: EnvironmentIngestionService = Object.create(
      EnvironmentIngestionService.prototype,
    );
    ingestion.processLease = jest.fn();
    const metrics = metricsHarness();
    const service = new EnvironmentCronService(dataSource, gate, store, ingestion, metrics.service);

    await service.syncDueProviders();
    await service.retainCanonicalObservations();

    expect(dataSource.query).toHaveBeenCalledTimes(1);
    expect(store.reconcileSyncStates).not.toHaveBeenCalled();
    expect(store.claimDue).not.toHaveBeenCalled();
    expect(store.retainSchema).not.toHaveBeenCalled();
    expect(metrics.recordCronRun).toHaveBeenNthCalledWith(1, {
      job: 'provider_sync',
      outcome: 'disabled',
      durationSeconds: 0,
    });
    expect(metrics.recordCronRun).toHaveBeenNthCalledWith(2, {
      job: 'retention',
      outcome: 'success',
      durationSeconds: 0,
    });
  });

  it('derives the lease from the bounded worst-case provider execution budget', () => {
    expect(ENVIRONMENT_MAX_PROVIDER_EXECUTION_MS).toBeGreaterThan(60 * 60 * 1_000);
    expect(ENVIRONMENT_LEASE_DURATION_MS).toBeGreaterThanOrEqual(
      ENVIRONMENT_MAX_PROVIDER_EXECUTION_MS,
    );
    expect(DEFAULT_CMEMS_CACHE_POLICY.capabilityFreshMs).toBeGreaterThanOrEqual(
      ENVIRONMENT_MAX_PROVIDER_EXECUTION_MS,
    );
    expect(DEFAULT_CMEMS_CACHE_POLICY.discoveryFreshMs).toBeGreaterThanOrEqual(
      ENVIRONMENT_MAX_PROVIDER_EXECUTION_MS,
    );
  });

  it('passes authoritative tenant identities through a deterministic rotated claim cursor', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        schema_name: SCHEMA_A,
        tenant_id: TENANT_A,
        schema_exists: true,
        committed_proof: true,
      },
      {
        schema_name: SCHEMA_B,
        tenant_id: TENANT_B,
        schema_exists: true,
        committed_proof: true,
      },
    ]);
    const dataSource: DataSource = Object.create(DataSource.prototype);
    dataSource.query = query;
    const gate: EnvironmentMonitoringGate = Object.create(EnvironmentMonitoringGate.prototype);
    gate.isEnabled = jest.fn().mockReturnValue(true);
    const claimDue = jest.fn().mockResolvedValue([]);
    const reconcileSyncStates = jest.fn().mockResolvedValue(undefined);
    const store: EnvironmentSyncStore = Object.create(EnvironmentSyncStore.prototype);
    store.reconcileSyncStates = reconcileSyncStates;
    store.claimDue = claimDue;
    store.measureDueBacklog = jest.fn().mockResolvedValue({ dueCount: 0, oldestDueAt: null });
    const ingestion: EnvironmentIngestionService = Object.create(
      EnvironmentIngestionService.prototype,
    );
    ingestion.processLease = jest.fn();
    const metrics = metricsHarness();
    const service = new EnvironmentCronService(dataSource, gate, store, ingestion, metrics.service);

    await service.syncDueProviders();
    await service.syncDueProviders();

    const attemptsPerRun = 2;
    const expectedFirstRun = [
      [SCHEMA_A, TENANT_A],
      [SCHEMA_B, TENANT_B],
    ];
    const expectedSecondRun = [
      [SCHEMA_B, TENANT_B],
      [SCHEMA_A, TENANT_A],
    ];
    const identityCalls = claimDue.mock.calls.map(([schemaName, tenantId]) => [
      schemaName,
      tenantId,
    ]);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('platform.list_active_tenant_schema_mappings()'),
    );
    expect(claimDue).toHaveBeenCalledTimes(attemptsPerRun * 2);
    expect(identityCalls.slice(0, attemptsPerRun)).toEqual(expectedFirstRun);
    expect(identityCalls.slice(attemptsPerRun)).toEqual(expectedSecondRun);
    expect(
      reconcileSyncStates.mock.calls.map(([schemaName, tenantId]) => [schemaName, tenantId]),
    ).toEqual([...expectedFirstRun, ...expectedSecondRun]);
    expect(ingestion.processLease).not.toHaveBeenCalled();
  });

  it('quarantines a tenant sweep when its one state reconciliation fails', async () => {
    const dataSource: DataSource = Object.create(DataSource.prototype);
    dataSource.query = jest.fn().mockResolvedValue([
      {
        schema_name: SCHEMA_A,
        tenant_id: TENANT_A,
        schema_exists: true,
        committed_proof: true,
      },
    ]);
    const gate: EnvironmentMonitoringGate = Object.create(EnvironmentMonitoringGate.prototype);
    gate.isEnabled = jest.fn().mockReturnValue(true);
    const store: EnvironmentSyncStore = Object.create(EnvironmentSyncStore.prototype);
    store.reconcileSyncStates = jest.fn().mockRejectedValue(new Error('database unavailable'));
    store.claimDue = jest.fn();
    store.measureDueBacklog = jest.fn();
    const ingestion: EnvironmentIngestionService = Object.create(
      EnvironmentIngestionService.prototype,
    );
    ingestion.processLease = jest.fn();
    const metrics = metricsHarness();
    const service = new EnvironmentCronService(dataSource, gate, store, ingestion, metrics.service);

    await service.syncDueProviders();

    expect(store.reconcileSyncStates).toHaveBeenCalledTimes(1);
    expect(store.claimDue).not.toHaveBeenCalled();
    expect(store.measureDueBacklog).not.toHaveBeenCalled();
    expect(ingestion.processLease).not.toHaveBeenCalled();
    expect(metrics.recordInternalFailure).toHaveBeenCalledWith('state_reconciliation');
    expect(metrics.recordCronRun).toHaveBeenCalledWith({
      job: 'provider_sync',
      outcome: 'partial_failure',
      durationSeconds: 0,
    });
  });

  it('reconciles once per tenant and fairly drains 1000 sites in four-lease batches', async () => {
    const dataSource: DataSource = Object.create(DataSource.prototype);
    dataSource.query = jest.fn().mockResolvedValue([
      {
        schema_name: SCHEMA_A,
        tenant_id: TENANT_A,
        schema_exists: true,
        committed_proof: true,
      },
      {
        schema_name: SCHEMA_B,
        tenant_id: TENANT_B,
        schema_exists: true,
        committed_proof: true,
      },
    ]);
    const gate: EnvironmentMonitoringGate = Object.create(EnvironmentMonitoringGate.prototype);
    gate.isEnabled = jest.fn().mockReturnValue(true);
    const providers = [
      EnvironmentProvider.MET_LOCATIONFORECAST,
      EnvironmentProvider.MET_FROST,
      EnvironmentProvider.CMEMS,
      EnvironmentProvider.CDSE_SENTINEL_2,
    ] as const;
    const leasesPerTenant = 500;
    const buildLeases = (
      schema: string,
      tenantId: string,
      ordinalOffset: number,
    ): EnvironmentSyncLease[] =>
      Array.from({ length: leasesPerTenant }, (_, siteIndex): EnvironmentSyncLease => {
        const ordinal = ordinalOffset + siteIndex;
        return {
          schema,
          tenantId,
          siteId: `33333333-3333-4333-8333-${String(ordinal).padStart(12, '0')}`,
          provider: providers[siteIndex % providers.length]!,
          token: `44444444-4444-4444-8444-${String(ordinal).padStart(12, '0')}`,
          monitoringLocationRevision: 1,
          latitude: 60,
          longitude: 5,
          altitudeM: null,
          monitoringRadiusM: 2_000,
          monitoringArea: null,
          cursor: null,
          consecutiveFailures: 0,
        };
      });
    const dueByTenant = new Map<string, EnvironmentSyncLease[]>([
      [TENANT_A, buildLeases(SCHEMA_A, TENANT_A, 0)],
      [TENANT_B, buildLeases(SCHEMA_B, TENANT_B, leasesPerTenant)],
    ]);
    const claimDue = jest.fn(
      (
        _schema: string,
        tenantId: string,
        _dueCutoff: Date,
        _claimedAt: Date,
        limit: number,
      ): Promise<EnvironmentSyncLease[]> => {
        const due = dueByTenant.get(tenantId);
        if (!due) {
          throw new Error(`Unexpected tenant in test claim: ${tenantId}`);
        }
        return Promise.resolve(due.splice(0, limit));
      },
    );
    const reconcileSyncStates = jest.fn().mockResolvedValue(undefined);
    const store: EnvironmentSyncStore = Object.create(EnvironmentSyncStore.prototype);
    store.reconcileSyncStates = reconcileSyncStates;
    store.claimDue = claimDue;
    store.measureDueBacklog = jest
      .fn()
      .mockResolvedValueOnce({
        dueCount: leasesPerTenant,
        oldestDueAt: new Date(NOW.getTime() - 30 * 60 * 1_000),
      })
      .mockResolvedValueOnce({
        dueCount: leasesPerTenant,
        oldestDueAt: new Date(NOW.getTime() - 30 * 60 * 1_000),
      })
      .mockResolvedValueOnce({ dueCount: 0, oldestDueAt: null })
      .mockResolvedValueOnce({ dueCount: 0, oldestDueAt: null });
    const ingestion: EnvironmentIngestionService = Object.create(
      EnvironmentIngestionService.prototype,
    );
    let active = 0;
    let maximumActive = 0;
    const processed: EnvironmentSyncLease[] = [];
    ingestion.processLease = jest.fn().mockImplementation(async (lease: EnvironmentSyncLease) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      processed.push(lease);
      await Promise.resolve();
      active -= 1;
      return true;
    });
    const metrics = metricsHarness();
    const service = new EnvironmentCronService(dataSource, gate, store, ingestion, metrics.service);

    await service.syncDueProviders();

    expect(processed).toHaveLength(leasesPerTenant * 2);
    expect(
      new Set(processed.map((lease) => `${lease.tenantId}:${lease.siteId}:${lease.provider}`)).size,
    ).toBe(leasesPerTenant * 2);
    expect(maximumActive).toBeLessThanOrEqual(ENVIRONMENT_PROVIDER_CONCURRENCY);
    expect(reconcileSyncStates).toHaveBeenCalledTimes(2);
    expect(reconcileSyncStates).toHaveBeenNthCalledWith(1, SCHEMA_A, TENANT_A, NOW);
    expect(reconcileSyncStates).toHaveBeenNthCalledWith(2, SCHEMA_B, TENANT_B, NOW);
    expect(store.measureDueBacklog).toHaveBeenCalledTimes(4);
    expect(dataSource.query).toHaveBeenCalledTimes(1);
    const nonEmptyBatchCount = (leasesPerTenant * 2) / ENVIRONMENT_CLAIM_BATCH_SIZE;
    expect(claimDue).toHaveBeenCalledTimes(nonEmptyBatchCount + 2);
    expect(claimDue.mock.calls.every((call) => call[4] === ENVIRONMENT_CLAIM_BATCH_SIZE)).toBe(
      true,
    );
    const claimTenantOrder = claimDue.mock.calls.map((call) => call[1]);
    expect(claimTenantOrder.slice(0, nonEmptyBatchCount)).toEqual(
      Array.from({ length: nonEmptyBatchCount / 2 }, () => [TENANT_A, TENANT_B]).flat(),
    );
    expect(claimTenantOrder.slice(nonEmptyBatchCount)).toEqual([TENANT_A, TENANT_B]);
    expect(metrics.recordHeartbeat).toHaveBeenCalledTimes(1 + leasesPerTenant * 2);
    expect(metrics.setDueBacklog).toHaveBeenNthCalledWith(1, {
      dueCount: leasesPerTenant * 2,
      oldestDueAgeSeconds: 30 * 60,
    });
    expect(metrics.setDueBacklog).toHaveBeenLastCalledWith({
      dueCount: 0,
      oldestDueAgeSeconds: 0,
    });
  });

  it('holds a fixed due cutoff while refreshing the lease clock so a state runs once per sweep', async () => {
    const dataSource: DataSource = Object.create(DataSource.prototype);
    dataSource.query = jest.fn().mockResolvedValue([
      {
        schema_name: SCHEMA_A,
        tenant_id: TENANT_A,
        schema_exists: true,
        committed_proof: true,
      },
    ]);
    const gate: EnvironmentMonitoringGate = Object.create(EnvironmentMonitoringGate.prototype);
    gate.isEnabled = jest.fn().mockReturnValue(true);
    const lease: EnvironmentSyncLease = {
      schema: SCHEMA_A,
      tenantId: TENANT_A,
      siteId: '33333333-3333-4333-8333-333333333333',
      provider: EnvironmentProvider.MET_LOCATIONFORECAST,
      token: '44444444-4444-4444-8444-444444444444',
      monitoringLocationRevision: 1,
      latitude: 60,
      longitude: 5,
      altitudeM: null,
      monitoringRadiusM: 2_000,
      monitoringArea: null,
      cursor: null,
      consecutiveFailures: 0,
    };
    let nextRunAt = NOW;
    let claimAttempts = 0;
    const claimDue = jest.fn(
      (
        _schema: string,
        _tenantId: string,
        dueCutoff: Date,
        claimedAt: Date,
      ): Promise<EnvironmentSyncLease[]> => {
        claimAttempts += 1;
        if (claimAttempts > 2) {
          throw new Error('same state was reclaimed within one scheduler sweep');
        }
        if (nextRunAt.getTime() > dueCutoff.getTime()) {
          return Promise.resolve([]);
        }
        nextRunAt = new Date(claimedAt.getTime() + 60_000);
        return Promise.resolve([lease]);
      },
    );
    const store: EnvironmentSyncStore = Object.create(EnvironmentSyncStore.prototype);
    store.reconcileSyncStates = jest.fn().mockResolvedValue(undefined);
    store.claimDue = claimDue;
    store.measureDueBacklog = jest
      .fn()
      .mockResolvedValueOnce({ dueCount: 1, oldestDueAt: NOW })
      .mockResolvedValueOnce({ dueCount: 1, oldestDueAt: nextRunAt });
    const ingestion: EnvironmentIngestionService = Object.create(
      EnvironmentIngestionService.prototype,
    );
    ingestion.processLease = jest.fn().mockImplementation(() => {
      jest.advanceTimersByTime(2 * 60 * 1_000);
      return Promise.resolve(true);
    });
    const metrics = metricsHarness();
    const service = new EnvironmentCronService(dataSource, gate, store, ingestion, metrics.service);

    await service.syncDueProviders();

    expect(ingestion.processLease).toHaveBeenCalledTimes(1);
    expect(claimDue).toHaveBeenCalledTimes(2);
    expect(claimDue.mock.calls[0]?.[2]).toEqual(NOW);
    expect(claimDue.mock.calls[1]?.[2]).toEqual(NOW);
    expect(claimDue.mock.calls[0]?.[3]).toEqual(NOW);
    expect(claimDue.mock.calls[1]?.[3]).toEqual(new Date(NOW.getTime() + 2 * 60 * 1_000));
    expect(nextRunAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(nextRunAt.getTime()).toBeLessThan(Date.now());
    expect(metrics.setDueBacklog).toHaveBeenLastCalledWith({
      dueCount: 1,
      oldestDueAgeSeconds: 2 * 60,
    });
  });

  it('fails closed before claims when the ledger schema and tenant identity disagree', async () => {
    const dataSource: DataSource = Object.create(DataSource.prototype);
    dataSource.query = jest.fn().mockResolvedValue([
      {
        schema_name: SCHEMA_A,
        tenant_id: TENANT_B,
        schema_exists: true,
        committed_proof: true,
      },
    ]);
    const gate: EnvironmentMonitoringGate = Object.create(EnvironmentMonitoringGate.prototype);
    gate.isEnabled = jest.fn().mockReturnValue(true);
    const store: EnvironmentSyncStore = Object.create(EnvironmentSyncStore.prototype);
    store.reconcileSyncStates = jest.fn();
    store.claimDue = jest.fn();
    const ingestion: EnvironmentIngestionService = Object.create(
      EnvironmentIngestionService.prototype,
    );
    ingestion.processLease = jest.fn();
    const metrics = metricsHarness();
    const service = new EnvironmentCronService(dataSource, gate, store, ingestion, metrics.service);

    await expect(service.syncDueProviders()).rejects.toThrow(/mapping mismatch/u);

    expect(store.claimDue).not.toHaveBeenCalled();
    expect(metrics.recordInternalFailure).toHaveBeenCalledWith('tenant_discovery');
    expect(metrics.recordCronRun).toHaveBeenCalledWith({
      job: 'provider_sync',
      outcome: 'error',
      durationSeconds: 0,
    });
  });

  it('uses one 45-day cutoff for weather, marine, scenes, and obsolete states', async () => {
    const dataSource: DataSource = Object.create(DataSource.prototype);
    dataSource.query = jest.fn().mockResolvedValue([
      {
        schema_name: 'tenant_aaaaaaaaaaaa4aaa',
        tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        schema_exists: true,
        committed_proof: true,
      },
    ]);
    const gate: EnvironmentMonitoringGate = Object.create(EnvironmentMonitoringGate.prototype);
    gate.isEnabled = jest.fn().mockReturnValue(true);
    const retainSchema = jest.fn().mockResolvedValue({
      weatherDeleted: 0,
      marineDeleted: 0,
      scenesDeleted: 0,
      obsoleteStatesDeleted: 0,
    });
    const store: EnvironmentSyncStore = Object.create(EnvironmentSyncStore.prototype);
    store.retainSchema = retainSchema;
    const ingestion: EnvironmentIngestionService = Object.create(
      EnvironmentIngestionService.prototype,
    );
    ingestion.processLease = jest.fn();
    const metrics = metricsHarness();
    const service = new EnvironmentCronService(dataSource, gate, store, ingestion, metrics.service);

    await service.retainCanonicalObservations();

    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('platform.list_retained_tenant_schema_mappings()'),
    );
    expect(retainSchema).toHaveBeenCalledWith(
      'tenant_aaaaaaaaaaaa4aaa',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      new Date('2026-06-16T04:00:00.000Z'),
    );
    expect(metrics.recordRetentionDeleted).toHaveBeenCalledTimes(4);
    expect(metrics.recordCronRun).toHaveBeenCalledWith({
      job: 'retention',
      outcome: 'success',
      durationSeconds: 0,
    });
  });

  it('preserves the last complete backlog sample when any tenant measurement is unknown', async () => {
    const dataSource: DataSource = Object.create(DataSource.prototype);
    dataSource.query = jest.fn().mockResolvedValue([
      {
        schema_name: SCHEMA_A,
        tenant_id: TENANT_A,
        schema_exists: true,
        committed_proof: true,
      },
      {
        schema_name: SCHEMA_B,
        tenant_id: TENANT_B,
        schema_exists: true,
        committed_proof: true,
      },
    ]);
    const gate: EnvironmentMonitoringGate = Object.create(EnvironmentMonitoringGate.prototype);
    gate.isEnabled = jest.fn().mockReturnValue(true);
    const store: EnvironmentSyncStore = Object.create(EnvironmentSyncStore.prototype);
    store.reconcileSyncStates = jest.fn().mockResolvedValue(undefined);
    store.claimDue = jest.fn().mockResolvedValue([]);
    store.measureDueBacklog = jest
      .fn()
      .mockImplementation((_schema: string, tenantId: string) =>
        tenantId === TENANT_A
          ? Promise.reject(new Error('tenant unavailable'))
          : Promise.resolve({ dueCount: 12, oldestDueAt: NOW }),
      );
    const ingestion: EnvironmentIngestionService = Object.create(
      EnvironmentIngestionService.prototype,
    );
    ingestion.processLease = jest.fn();
    const metrics = metricsHarness();
    const service = new EnvironmentCronService(dataSource, gate, store, ingestion, metrics.service);

    await service.syncDueProviders();

    expect(store.measureDueBacklog).toHaveBeenCalledTimes(4);
    expect(metrics.setDueBacklog).not.toHaveBeenCalled();
    expect(metrics.recordInternalFailure).toHaveBeenCalledTimes(2);
    expect(metrics.recordInternalFailure).toHaveBeenCalledWith('backlog_measurement');
    expect(metrics.recordCronRun).toHaveBeenCalledWith({
      job: 'provider_sync',
      outcome: 'partial_failure',
      durationSeconds: 0,
    });
  });
});
