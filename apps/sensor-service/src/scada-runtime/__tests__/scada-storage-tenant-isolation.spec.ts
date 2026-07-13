/**
 * SCADA storage tenant-isolation invariant (DB-SENSOR-CRITICAL-001 / SENSOR-HIGH-004).
 *
 * The SCADA alarm/history tables are cross-tenant infrastructure in the shared
 * `sensor` schema. Before the 2026-07-11 fix they had no tenant_id and every
 * read was an unfiltered SELECT — one tenant's operator would read every
 * tenant's alarms. These tests pin the two structural guarantees that close
 * the leak:
 *   1. every read/write carries the caller's tenantId as a SQL predicate/value;
 *   2. an empty/unbound tenant fails closed (throws) instead of falling through
 *      to all tenants' rows.
 *
 * London-school: the DataSource is a mock; we assert on the SQL text + params
 * the services hand it, which is exactly where the tenant fence lives.
 */
import { AlarmStorageService } from '../services/alarm-storage.service';
import { DaqStorageService } from '../services/daq-storage.service';
import { AlarmEngineService } from '../services/alarm-engine.service';
import type { ScadaAlarm, ScadaAlarmChronicle } from '../entities/alarm.entity';

type QueryCall = { sql: string; params: unknown[] };

function makeDataSourceMock(queryImpl?: (sql: string, params?: unknown[]) => unknown) {
  const calls: QueryCall[] = [];
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params: params ?? [] });
    return queryImpl ? queryImpl(sql, params) : [];
  });
  return { dataSource: { query } as never, calls };
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

describe('AlarmStorageService — tenant fencing', () => {
  it('saveAlarm stamps tenant_id as the first inserted value', async () => {
    const { dataSource, calls } = makeDataSourceMock();
    const svc = new AlarmStorageService(dataSource);

    await svc.saveAlarm(TENANT_A, sampleAlarm);

    expect(calls[0]!.sql).toContain('tenant_id');
    expect(calls[0]!.params[0]).toBe(TENANT_A);
  });

  it('getActiveAlarms filters by tenant_id and passes only the tenantId param', async () => {
    const { dataSource, calls } = makeDataSourceMock(() => []);
    const svc = new AlarmStorageService(dataSource);

    await svc.getActiveAlarms(TENANT_B);

    expect(calls[0]!.sql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1/);
    expect(calls[0]!.params).toEqual([TENANT_B]);
  });

  it('getAlarmHistory fences tenant as the first predicate regardless of filters', async () => {
    const { dataSource, calls } = makeDataSourceMock(() => []);
    const svc = new AlarmStorageService(dataSource);

    await svc.getAlarmHistory(TENANT_A, { severity: ['critical'], textSearch: 'x' });

    expect(calls[0]!.sql).toContain('tenant_id = $1');
    expect(calls[0]!.params[0]).toBe(TENANT_A);
  });

  it('deleteAlarm scopes the delete to the tenant', async () => {
    const { dataSource, calls } = makeDataSourceMock();
    const svc = new AlarmStorageService(dataSource);

    await svc.deleteAlarm(TENANT_A, 'alarm-1');

    expect(calls[0]!.sql).toContain('tenant_id = $2');
    expect(calls[0]!.params).toEqual(['alarm-1', TENANT_A]);
  });

  it('saveToChronicle stamps tenant_id', async () => {
    const { dataSource, calls } = makeDataSourceMock();
    const svc = new AlarmStorageService(dataSource);

    await svc.saveToChronicle(TENANT_A, sampleAlarm as ScadaAlarmChronicle);

    expect(calls[0]!.sql).toContain('tenant_id');
    expect(calls[0]!.params[0]).toBe(TENANT_A);
  });

  it.each([
    ['saveAlarm', (s: AlarmStorageService) => s.saveAlarm('', sampleAlarm)],
    ['getActiveAlarms', (s: AlarmStorageService) => s.getActiveAlarms('')],
    ['getAlarmHistory', (s: AlarmStorageService) => s.getAlarmHistory('  ')],
    ['deleteAlarm', (s: AlarmStorageService) => s.deleteAlarm('', 'a')],
    ['saveToChronicle', (s: AlarmStorageService) => s.saveToChronicle('', sampleAlarm as ScadaAlarmChronicle)],
  ])('%s fails closed on an empty tenantId', async (_name, call) => {
    const { dataSource } = makeDataSourceMock();
    const svc = new AlarmStorageService(dataSource);
    await expect(call(svc)).rejects.toThrow(/tenantId is required/);
  });
});

describe('DaqStorageService — tenant fencing', () => {
  it('addValues stamps tenant_id as the leading column of every row', async () => {
    const { dataSource, calls } = makeDataSourceMock();
    const svc = new DaqStorageService(dataSource, null);

    await svc.addValues(TENANT_A, 'device-1', [
      { tagId: 'tag-1', value: 10, timestamp: 1_700_000_000_000, quality: 'good' },
    ]);

    expect(calls[0]!.sql).toContain('(tenant_id, tag_id, timestamp, value, quality)');
    expect(calls[0]!.params[0]).toBe(TENANT_A);
  });

  it('queryValues fences tenant as the first predicate', async () => {
    const { dataSource, calls } = makeDataSourceMock(() => []);
    const svc = new DaqStorageService(dataSource, null);

    await svc.queryValues(TENANT_B, ['tag-1'], new Date(0), new Date(1));

    expect(calls[0]!.sql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1/);
    expect(calls[0]!.params[0]).toBe(TENANT_B);
  });

  it.each([
    ['addValues', (s: DaqStorageService) => s.addValues('', 'd', [{ tagId: 't', value: 1, timestamp: 0, quality: 'good' }])],
    ['queryValues', (s: DaqStorageService) => s.queryValues('', ['t'], new Date(0), new Date(1))],
  ])('%s fails closed on an empty tenantId', async (_name, call) => {
    const { dataSource } = makeDataSourceMock();
    const svc = new DaqStorageService(dataSource, null);
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

  it('setTenantId rejects an empty tenantId', () => {
    const engine = makeEngine({});
    expect(() => engine.setTenantId('')).toThrow(/non-empty tenantId is required/);
  });

  it('accepts a real tenant and exposes no cross-tenant state through getActiveAlarms', () => {
    const engine = makeEngine({});
    engine.setTenantId(TENANT_A);
    // With no rules loaded the in-memory active set is empty — the engine
    // never fabricates another tenant's alarms.
    expect(engine.getActiveAlarms()).toEqual([]);
  });
});
