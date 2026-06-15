/**
 * minioOrphanCleanup per-tenant driving tests.
 *
 * Locks the root-cause fix for the cross-tenant whole-bucket deletion
 * class: the nightly cron MUST run the cleanup once per tenant, inside
 * that tenant's context, scoped to that tenant's bucket prefix
 * (`${tenantId}/`). Without tenant context the live-paths providers read
 * the empty source schema while the bucket scan stays global — which
 * would delete every tenant's objects.
 *
 * A schema with no document references is skipped (there is nothing this
 * cleanup could safely delete; the storage layer also refuses
 * empty-live-set deletion — see orphan-cleanup.service.spec.ts).
 *
 * The service is built via Nest's testing module so every collaborator
 * is injected as a typed provider (no hand-cast mocks).
 */
import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { CronJobsService } from '../cron-jobs.service';
import { FarmOrphanCleanupService } from '../../common/file-cleanup/farm-orphan-cleanup.service';
import { MaintenanceSchedule } from '../../maintenance/entities/maintenance-schedule.entity';
import { SparePart } from '../../maintenance/entities/spare-part.entity';
import { WorkOrder } from '../../maintenance/entities/work-order.entity';
import { MaintenanceScheduleService } from '../../maintenance/services/maintenance-schedule.service';
import { SparePartService } from '../../maintenance/services/spare-part.service';

const TENANT_A = '4b529829-ea79-48da-982c-cd6fbec8ffb7';
const SCHEMA_A = 'tenant_4b529829ea7948da';
const TENANT_B = 'a1b2c3d4-e5f6-47a8-99b0-c1d2e3f4a5b6';
const SCHEMA_B = 'tenant_a1b2c3d4e5f647a8';
const SCHEMA_EMPTY = 'tenant_00000000deadbeef';

function makeDataSource(schemaTenantMap: Record<string, string | null>) {
  const schemas = Object.keys(schemaTenantMap);

  const createQueryRunner = jest.fn(() => {
    let schema = '';
    const query = jest.fn(async (sql: string) => {
      const setMatch = /SET search_path TO "([^"]+)"/.exec(sql);
      if (setMatch) {
        schema = setMatch[1] ?? '';
        return [];
      }
      if (sql.startsWith('SELECT "tenantId"')) {
        const tid = schemaTenantMap[schema];
        return tid ? [{ tenantId: tid }] : [];
      }
      return [];
    });
    return { connect: jest.fn(), query, release: jest.fn() };
  });

  const query = jest.fn(async (sql: string) => {
    if (sql.includes('information_schema.schemata')) {
      return schemas.map((schema_name) => ({ schema_name }));
    }
    return [];
  });

  return { query, createQueryRunner };
}

function makeOrphanCleanup() {
  const run = jest.fn(async () => ({
    totalScanned: 0,
    live: 0,
    deleted: 0,
    tooNew: 0,
    capped: false,
    errors: [],
    durationMs: 1,
    refused: false,
    providersUsed: [],
    startedAt: 'x',
  }));
  return { orphanCleanup: { run }, run };
}

async function makeService(
  dataSource: ReturnType<typeof makeDataSource>,
  orphanCleanup?: ReturnType<typeof makeOrphanCleanup>['orphanCleanup'],
): Promise<CronJobsService> {
  const providers: Provider[] = [
    CronJobsService,
    { provide: DataSource, useValue: dataSource },
    { provide: getRepositoryToken(MaintenanceSchedule), useValue: {} },
    { provide: getRepositoryToken(WorkOrder), useValue: {} },
    { provide: getRepositoryToken(SparePart), useValue: {} },
    { provide: MaintenanceScheduleService, useValue: {} },
    { provide: SparePartService, useValue: {} },
    { provide: SchedulerRegistry, useValue: {} },
    { provide: EventEmitter2, useValue: {} },
    { provide: ConfigService, useValue: {} },
  ];
  if (orphanCleanup) {
    providers.push({ provide: FarmOrphanCleanupService, useValue: orphanCleanup });
  }
  // .compile() instantiates providers but does NOT run onModuleInit, so the
  // service's stale-config cleanup timer never starts (no leaked handles).
  const moduleRef = await Test.createTestingModule({ providers }).compile();
  return moduleRef.get(CronJobsService);
}

describe('CronJobsService.minioOrphanCleanup (per-tenant driving)', () => {
  it('runs cleanup once per tenant, scoped to that tenant bucket prefix', async () => {
    const dataSource = makeDataSource({ [SCHEMA_A]: TENANT_A });
    const { orphanCleanup, run } = makeOrphanCleanup();

    const service = await makeService(dataSource, orphanCleanup);
    await service.minioOrphanCleanup();

    expect(run).toHaveBeenCalledTimes(1);
    // The bucket scan + delete is confined to THIS tenant's prefix.
    expect(run).toHaveBeenCalledWith({ prefix: `${TENANT_A}/` });
  });

  it('skips schemas with no document references (never scans blind)', async () => {
    const dataSource = makeDataSource({ [SCHEMA_EMPTY]: null });
    const { orphanCleanup, run } = makeOrphanCleanup();

    const service = await makeService(dataSource, orphanCleanup);
    await service.minioOrphanCleanup();

    expect(run).not.toHaveBeenCalled();
  });

  it('processes each tenant independently across multiple schemas', async () => {
    const dataSource = makeDataSource({
      [SCHEMA_A]: TENANT_A,
      [SCHEMA_B]: TENANT_B,
      [SCHEMA_EMPTY]: null,
    });
    const { orphanCleanup, run } = makeOrphanCleanup();

    const service = await makeService(dataSource, orphanCleanup);
    await service.minioOrphanCleanup();

    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith({ prefix: `${TENANT_A}/` });
    expect(run).toHaveBeenCalledWith({ prefix: `${TENANT_B}/` });
  });

  it('is a no-op when FarmOrphanCleanupService is not registered', async () => {
    const dataSource = makeDataSource({ [SCHEMA_A]: TENANT_A });

    const service = await makeService(dataSource, undefined);
    await service.minioOrphanCleanup();

    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });
});
