/**
 * SCADA storage tenant-isolation invariant (DB-SENSOR-CRITICAL-001 / ORPHAN-414).
 *
 * The SCADA alarm/history tables are cross-tenant infrastructure in the shared
 * `sensor` schema, carrying a FORCED `tenant_isolation_policy`. These tests pin
 * the RT-011 Faz 2 write architecture:
 *   1. every per-tenant write/read runs INSIDE a tenant-context transaction
 *      (`runInTenantTransaction`/`runInTenantRead`) so `app.current_tenant` is
 *      set and the RLS policy ENFORCES the row — not a raw pooled query;
 *   2. the genuinely cross-tenant maintenance sweeps (retention, data-bounds)
 *      run under the audited `BypassRlsService.withBypass`, NOT a tenant context;
 *   3. an empty/unbound tenant fails closed (throws).
 *
 * The two tenant-context helpers are mocked to invoke their callback with a
 * recording query-runner — the tenant-context assertion machinery itself is
 * backend-common's own tested concern; here we assert the SQL the services
 * build and that they route through the correct helper.
 */

// `mock`-prefixed so the jest.mock factory may reference them (hoist rule).
const mockQrCalls: Array<{ sql: string; params: unknown[] }> = [];
let mockQrImpl: ((sql: string, params?: unknown[]) => unknown) | undefined;
const mockQr = {
  query: jest.fn(async (sql: string, params?: unknown[]) => {
    mockQrCalls.push({ sql, params: params ?? [] });
    return mockQrImpl ? mockQrImpl(sql, params) : [];
  }),
};

jest.mock('@aquaculture/backend-common/database', () => {
  const actual = jest.requireActual('@aquaculture/backend-common/database');
  return {
    __esModule: true,
    ...actual,
    runInTenantTransaction: jest.fn(
      (_ds: unknown, _schema: string, _tenantId: string, fn: (qr: unknown) => unknown) =>
        fn(mockQr),
    ),
    runInTenantRead: jest.fn(
      (_ds: unknown, _schema: string, _tenantId: string, fn: (qr: unknown) => unknown) =>
        fn(mockQr),
    ),
  };
});

import { runInTenantTransaction, runInTenantRead } from '@aquaculture/backend-common/database';

import { AlarmStorageService } from '../services/alarm-storage.service';
import type { ScadaAlarmWriteBatch } from '../services/alarm-storage.service';
import { DaqStorageService } from '../services/daq-storage.service';
import { AlarmEngineService } from '../services/alarm-engine.service';
import type { ScadaAlarm, ScadaAlarmChronicle } from '../entities/alarm.entity';

type QueryCall = { sql: string; params: unknown[] };

/** DataSource mock — used only by the bypass sweeps + catalog checks. */
function makeDataSourceMock(queryImpl?: (sql: string, params?: unknown[]) => unknown) {
  const calls: QueryCall[] = [];
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params: params ?? [] });
    return queryImpl ? queryImpl(sql, params) : [];
  });
  return { dataSource: { query } as never, calls };
}

/** BypassRlsService mock — records the audit label, runs the callback. */
function makeBypassMock() {
  const labels: string[] = [];
  const withBypass = jest.fn(async (operation: string, cb: () => unknown) => {
    labels.push(operation);
    return cb();
  });
  return { bypass: { withBypass } as never, labels };
}

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

const sampleAlarm: ScadaAlarm = {
  id: 'alarm-1',
  ruleId: 'rule-1',
  ruleName: 'High temp',
  severity: 'critical',
  status: 'active',
  message: 'over threshold',
  group: undefined,
  currentValue: 42,
  threshold: 30,
  onTime: 1_700_000_000_000,
  offTime: undefined,
  ackTime: undefined,
  ackUserId: undefined,
  colors: undefined,
};

const runInTx = jest.mocked(runInTenantTransaction);
const runInRead = jest.mocked(runInTenantRead);

beforeEach(() => {
  mockQrCalls.length = 0;
  mockQrImpl = undefined;
  runInTx.mockClear();
  runInRead.mockClear();
});

describe('AlarmStorageService — tenant-context writes (RLS-enforced)', () => {
  it('flushTenantBatch upserts under runInTenantTransaction for the tenant', async () => {
    const { dataSource } = makeDataSourceMock();
    const { bypass } = makeBypassMock();
    const svc = new AlarmStorageService(dataSource, bypass);

    const batch: ScadaAlarmWriteBatch = { upserts: [sampleAlarm], chronicles: [], deleteIds: [] };
    await svc.flushTenantBatch(TENANT_A, batch);

    expect(runInTx).toHaveBeenCalledWith(
      expect.anything(),
      'sensor',
      TENANT_A,
      expect.any(Function),
    );
    const upsert = mockQrCalls.find((c) => /INSERT INTO scada_alarms/.test(c.sql));
    expect(upsert).toBeDefined();
    expect(upsert!.sql).toContain('tenant_id');
    expect(upsert!.params[0]).toBe(TENANT_A);
  });

  it('flushTenantBatch batches multiple alarms into ONE multi-row upsert', async () => {
    const { dataSource } = makeDataSourceMock();
    const { bypass } = makeBypassMock();
    const svc = new AlarmStorageService(dataSource, bypass);

    const batch: ScadaAlarmWriteBatch = {
      upserts: [sampleAlarm, { ...sampleAlarm, id: 'alarm-2' }],
      chronicles: [],
      deleteIds: [],
    };
    await svc.flushTenantBatch(TENANT_A, batch);

    // ONE transaction, ONE INSERT with two value tuples (16 params each = 32).
    expect(runInTx).toHaveBeenCalledTimes(1);
    const upsert = mockQrCalls.find((c) => /INSERT INTO scada_alarms/.test(c.sql))!;
    expect(upsert.sql).toMatch(/\),\s*\(/); // two adjacent VALUES tuples
    expect(upsert.params).toHaveLength(32);
  });

  it('flushTenantBatch chronicles + deletes in the same tenant transaction', async () => {
    const { dataSource } = makeDataSourceMock();
    const { bypass } = makeBypassMock();
    const svc = new AlarmStorageService(dataSource, bypass);

    const batch: ScadaAlarmWriteBatch = {
      upserts: [],
      chronicles: [sampleAlarm as ScadaAlarmChronicle],
      deleteIds: ['alarm-9'],
    };
    await svc.flushTenantBatch(TENANT_A, batch);

    expect(runInTx).toHaveBeenCalledTimes(1);
    expect(mockQrCalls.some((c) => /INSERT INTO scada_alarm_chronicle/.test(c.sql))).toBe(true);
    const del = mockQrCalls.find((c) => /DELETE FROM scada_alarms/.test(c.sql))!;
    expect(del.params).toEqual([['alarm-9'], TENANT_A]);
  });

  it('flushTenantBatch is a no-op (no transaction) for an empty batch', async () => {
    const { dataSource } = makeDataSourceMock();
    const { bypass } = makeBypassMock();
    const svc = new AlarmStorageService(dataSource, bypass);

    await svc.flushTenantBatch(TENANT_A, { upserts: [], chronicles: [], deleteIds: [] });
    expect(runInTx).not.toHaveBeenCalled();
  });

  it('getActiveAlarms reads under runInTenantRead for the tenant', async () => {
    const { dataSource } = makeDataSourceMock();
    const { bypass } = makeBypassMock();
    const svc = new AlarmStorageService(dataSource, bypass);
    mockQrImpl = () => [];

    await svc.getActiveAlarms(TENANT_B);

    expect(runInRead).toHaveBeenCalledWith(
      expect.anything(),
      'sensor',
      TENANT_B,
      expect.any(Function),
    );
    expect(mockQrCalls[0]!.sql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1/);
    expect(mockQrCalls[0]!.params).toEqual([TENANT_B]);
  });

  it('getAlarmHistory reads under runInTenantRead, tenant fenced first', async () => {
    const { dataSource } = makeDataSourceMock();
    const { bypass } = makeBypassMock();
    const svc = new AlarmStorageService(dataSource, bypass);
    mockQrImpl = () => [];

    await svc.getAlarmHistory(TENANT_A, { severity: ['critical'], textSearch: 'x' });

    expect(runInRead).toHaveBeenCalledWith(
      expect.anything(),
      'sensor',
      TENANT_A,
      expect.any(Function),
    );
    expect(mockQrCalls[0]!.sql).toContain('tenant_id = $1');
    expect(mockQrCalls[0]!.params[0]).toBe(TENANT_A);
  });

  it('cleanupHistory runs under an audited RLS bypass, not a tenant context', async () => {
    const { dataSource, calls } = makeDataSourceMock(() => [[], 3]);
    const { bypass, labels } = makeBypassMock();
    const svc = new AlarmStorageService(dataSource, bypass);

    const deleted = await svc.cleanupHistory(30);

    expect(labels).toContain('scada:cleanup-alarm-chronicle');
    expect(runInTx).not.toHaveBeenCalled();
    expect(calls.some((c) => /DELETE FROM scada_alarm_chronicle/.test(c.sql))).toBe(true);
    expect(deleted).toBe(3);
  });

  it.each([
    [
      'flushTenantBatch',
      (s: AlarmStorageService) =>
        s.flushTenantBatch('', { upserts: [sampleAlarm], chronicles: [], deleteIds: [] }),
    ],
    ['getActiveAlarms', (s: AlarmStorageService) => s.getActiveAlarms('')],
    ['getAlarmHistory', (s: AlarmStorageService) => s.getAlarmHistory('  ')],
  ])('%s fails closed on an empty tenantId', async (_name, call) => {
    const { dataSource } = makeDataSourceMock();
    const { bypass } = makeBypassMock();
    const svc = new AlarmStorageService(dataSource, bypass);
    await expect(call(svc)).rejects.toThrow(/tenantId is required/);
  });
});

describe('DaqStorageService — tenant-context writes/reads + bypass sweeps', () => {
  it('addValues writes under runInTenantTransaction for the tenant', async () => {
    const { dataSource } = makeDataSourceMock();
    const { bypass } = makeBypassMock();
    const svc = new DaqStorageService(dataSource, bypass, null);

    await svc.addValues(TENANT_A, 'device-1', [
      { tagId: 'tag-1', value: 10, timestamp: 1_700_000_000_000, quality: 'good' },
    ]);

    expect(runInTx).toHaveBeenCalledWith(
      expect.anything(),
      'sensor',
      TENANT_A,
      expect.any(Function),
    );
    const insert = mockQrCalls[0]!;
    expect(insert.sql).toContain('(tenant_id, tag_id, timestamp, value, quality)');
    expect(insert.params[0]).toBe(TENANT_A);
  });

  it('queryValues reads under runInTenantRead, tenant fenced first', async () => {
    const { dataSource } = makeDataSourceMock();
    const { bypass } = makeBypassMock();
    const svc = new DaqStorageService(dataSource, bypass, null);
    mockQrImpl = () => [];

    await svc.queryValues(TENANT_B, ['tag-1'], new Date(0), new Date(1));

    expect(runInRead).toHaveBeenCalledWith(
      expect.anything(),
      'sensor',
      TENANT_B,
      expect.any(Function),
    );
    expect(mockQrCalls[0]!.sql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1/);
    expect(mockQrCalls[0]!.params[0]).toBe(TENANT_B);
  });

  it('cleanupOldData + getDataBounds run under audited RLS bypass', async () => {
    const { dataSource } = makeDataSourceMock((sql) =>
      /DELETE/.test(sql) ? [[], 5] : [{ oldest: null, newest: null }],
    );
    const { bypass, labels } = makeBypassMock();
    const svc = new DaqStorageService(dataSource, bypass, null);

    await svc.cleanupOldData(30);
    await svc.getDataBounds();

    expect(labels).toEqual(
      expect.arrayContaining(['scada:cleanup-tag-history', 'scada:tag-history-data-bounds']),
    );
    expect(runInTx).not.toHaveBeenCalled();
  });

  it.each([
    [
      'addValues',
      (s: DaqStorageService) =>
        s.addValues('', 'd', [{ tagId: 't', value: 1, timestamp: 0, quality: 'good' }]),
    ],
    ['queryValues', (s: DaqStorageService) => s.queryValues('', ['t'], new Date(0), new Date(1))],
  ])('%s fails closed on an empty tenantId', async (_name, call) => {
    const { dataSource } = makeDataSourceMock();
    const { bypass } = makeBypassMock();
    const svc = new DaqStorageService(dataSource, bypass, null);
    await expect(call(svc)).rejects.toThrow(/tenantId is required/);
  });
});

describe('AlarmEngineService — tenant binding', () => {
  function makeEngine(storage: Partial<AlarmStorageService>) {
    const gateway = { pushAlarmStatus: jest.fn() } as never;
    const tagManager = {} as never;
    const notification = {} as never;
    return new AlarmEngineService(tagManager, gateway, storage as never, notification);
  }

  it('setAlarmRules rejects an empty tenantId', () => {
    const engine = makeEngine({});
    expect(() => engine.setAlarmRules('', [])).toThrow(/non-empty tenantId is required/);
  });

  it('exposes no cross-tenant state through getActiveAlarms for an inactive tenant', () => {
    const engine = makeEngine({});
    expect(engine.getActiveAlarms(TENANT_A)).toEqual([]);
  });
});
