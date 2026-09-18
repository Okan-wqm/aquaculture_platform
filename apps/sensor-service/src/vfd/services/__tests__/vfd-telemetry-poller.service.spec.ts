/**
 * SENSOR-HIGH-067 — VFD telemetry must actually be read.
 *
 * `poll_interval_ms` and `is_polling_enabled` have been written by the
 * registration wizard and rendered on the device page since the table existed,
 * and nothing read them: sensor-service had three scheduled jobs and none touched
 * a drive. The frontend polled `vfd_readings` every three seconds and showed a
 * live indicator over rows that never changed.
 *
 * These cases pin the three properties that make the poller correct rather than
 * merely present: it sweeps per tenant schema, it honours each drive's own
 * cadence instead of one global rate, and one unreachable drive does not stop
 * the sweep.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ScheduledJobRunner } from '@aquaculture/backend-common/scheduling';
import { createScheduledJobTestExecutor } from '@aquaculture/backend-common/scheduling/testing';

import { VfdTelemetryPollerService } from '../vfd-telemetry-poller.service';
import { VfdDataReaderService } from '../vfd-data-reader.service';
import { VfdDeviceStatus } from '../../entities/vfd.enums';

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_TENANT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SCHEMA_A = 'tenant_aaaaaaaaaaaaaaaa';
const SCHEMA_B = 'tenant_bbbbbbbbbbbbbbbb';

interface DueRow {
  id: string;
}

/** The ledger's canonical schema → tenant mapping the verified fan-out hands the job. */
const TENANT_BY_SCHEMA: Record<string, string> = {
  [SCHEMA_A]: TENANT_ID,
  [SCHEMA_B]: OTHER_TENANT_ID,
};

/** Satisfies forEachTenantSchema's connect/transaction/SET/commit/release lifecycle. */
function buildQueryRunner(rowsBySchema: Map<string, DueRow[]>) {
  let txActive = false;
  let currentSchema = '';
  const seenSql: string[] = [];
  return {
    seenSql,
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockImplementation(() => {
      txActive = true;
      return Promise.resolve();
    }),
    commitTransaction: jest.fn().mockImplementation(() => {
      txActive = false;
      return Promise.resolve();
    }),
    rollbackTransaction: jest.fn().mockImplementation(() => {
      txActive = false;
      return Promise.resolve();
    }),
    get isTransactionActive(): boolean {
      return txActive;
    },
    query: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      if (typeof sql !== 'string') return Promise.resolve([]);
      seenSql.push(sql);
      if (sql.includes("set_config('search_path'")) {
        const arg = String(params?.[0] ?? '');
        currentSchema = /"([a-z0-9_]+)"/.exec(arg)?.[1] ?? '';
        return Promise.resolve([]);
      }
      if (sql.includes('FROM vfd_devices')) {
        return Promise.resolve(rowsBySchema.get(currentSchema) ?? []);
      }
      return Promise.resolve([]);
    }),
    release: jest.fn().mockResolvedValue(undefined),
  };
}

async function buildService(
  rowsBySchema: Map<string, DueRow[]>,
  schemas: string[],
  readImpl?: (deviceId: string, tenantId: string) => Promise<unknown>,
) {
  // The fan-out takes a DEDICATED runner per tenant and may run tenants
  // concurrently, so one shared mock would let two tenants overwrite each
  // other's search_path — a race the production code does not have.
  const runners: ReturnType<typeof buildQueryRunner>[] = [];
  const newRunner = (): ReturnType<typeof buildQueryRunner> => {
    const r = buildQueryRunner(rowsBySchema);
    runners.push(r);
    return r;
  };
  const dataSource = {
    // forEachVerifiedTenantSchema resolves identities from the provisioning
    // ledger, not from information_schema — that is the point of using it.
    query: jest.fn().mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('list_active_tenant_schema_mappings')) {
        return Promise.resolve(
          schemas.map((schemaName) => ({
            schema_name: schemaName,
            tenant_id: TENANT_BY_SCHEMA[schemaName],
            // The fan-out refuses an identity without both proofs; a mock that
            // omitted them would be exercising a tenant the real job skips.
            schema_exists: true,
            committed_proof: true,
          })),
        );
      }
      return Promise.resolve([]);
    }),
    createQueryRunner: jest.fn().mockImplementation(newRunner),
  };

  const dataReader = {
    readCriticalParameters: jest
      .fn()
      .mockImplementation(readImpl ?? (() => Promise.resolve({ success: true }))),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      VfdTelemetryPollerService,
      { provide: getDataSourceToken(), useValue: dataSource },
      { provide: VfdDataReaderService, useValue: dataReader },
      { provide: ScheduledJobRunner, useValue: createScheduledJobTestExecutor().executor },
    ],
  }).compile();

  return {
    service: module.get(VfdTelemetryPollerService),
    dataReader,
    /** Every statement any tenant's runner issued. */
    allSql: (): string[] => runners.flatMap((r) => r.seenSql),
    queryCalls: (): jest.Mock[] => runners.map((r) => r.query),
  };
}

describe('VfdTelemetryPollerService (SENSOR-HIGH-067)', () => {
  it('reads every due drive under the tenant identity the ledger vouches for', async () => {
    const { service, dataReader } = await buildService(new Map([[SCHEMA_A, [{ id: 'drive-1' }]]]), [
      SCHEMA_A,
    ]);

    await service.pollDueDevices();

    expect(dataReader.readCriticalParameters).toHaveBeenCalledWith('drive-1', TENANT_ID);
  });

  it('sweeps every tenant schema, not just the first', async () => {
    // vfd_devices is per-tenant, so an unscoped query would resolve against the
    // empty source-schema template and find nothing at all.
    const { service, dataReader } = await buildService(
      new Map([
        [SCHEMA_A, [{ id: 'drive-a' }]],
        [SCHEMA_B, [{ id: 'drive-b' }]],
      ]),
      [SCHEMA_A, SCHEMA_B],
    );

    await service.pollDueDevices();

    expect(dataReader.readCriticalParameters).toHaveBeenCalledWith('drive-a', TENANT_ID);
    expect(dataReader.readCriticalParameters).toHaveBeenCalledWith('drive-b', OTHER_TENANT_ID);
  });

  it('selects only ACTIVE, polling-enabled drives whose own interval has elapsed', async () => {
    const { service, allSql, queryCalls } = await buildService(new Map(), [SCHEMA_A]);

    await service.pollDueDevices();

    const discovery = allSql().find((sql) => sql.includes('FROM vfd_devices'));
    expect(discovery).toBeDefined();
    // The cadence lives on the row: replacing this with a fixed rate would make
    // poll_interval_ms decorative again, which is the finding.
    expect(discovery).toContain('d.poll_interval_ms');
    // No tenant_id read out of the swept schema: identity comes from the ledger.
    expect(discovery).not.toContain('d.tenant_id');
    expect(discovery).toContain('is_polling_enabled = TRUE');
    expect(discovery).toContain('last.timestamp IS NULL');
    expect(queryCalls()[0]).toHaveBeenCalledWith(expect.stringContaining('FROM vfd_devices'), [
      VfdDeviceStatus.ACTIVE,
    ]);
  });

  it('keeps sweeping when one drive is unreachable', async () => {
    // A failed edge read throws rather than fabricating telemetry. That is the
    // drive's problem; the other tenants still need their readings.
    const { service, dataReader } = await buildService(
      new Map([[SCHEMA_A, [{ id: 'broken-drive' }, { id: 'healthy-drive' }]]]),
      [SCHEMA_A],
      (deviceId: string) =>
        deviceId === 'broken-drive'
          ? Promise.reject(new Error('edge read timed out'))
          : Promise.resolve({ success: true }),
    );

    await expect(service.pollDueDevices()).resolves.toBeUndefined();

    expect(dataReader.readCriticalParameters).toHaveBeenCalledWith('healthy-drive', TENANT_ID);
  });

  it('does not start a cycle while the previous one is still running', async () => {
    // Two concurrent reads of one drive would race for the same Modbus connection.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });

    const { service, dataReader } = await buildService(
      new Map([[SCHEMA_A, [{ id: 'drive-1' }]]]),
      [SCHEMA_A],
      async () => {
        signalEntered();
        await gate;
        return { success: true };
      },
    );

    const first = service.pollDueDevices();
    // Wait until the first cycle is demonstrably inside the read, rather than
    // racing the assertion against the fan-out's own async prelude.
    await entered;

    await service.pollDueDevices();

    expect(dataReader.readCriticalParameters).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it('runs again once the previous cycle has finished', async () => {
    const { service, dataReader } = await buildService(new Map([[SCHEMA_A, [{ id: 'drive-1' }]]]), [
      SCHEMA_A,
    ]);

    await service.pollDueDevices();
    await service.pollDueDevices();

    expect(dataReader.readCriticalParameters).toHaveBeenCalledTimes(2);
  });
});
