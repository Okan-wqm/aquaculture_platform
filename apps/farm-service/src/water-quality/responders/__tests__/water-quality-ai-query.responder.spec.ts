import 'reflect-metadata';

import { QueryBus } from '@platform/cqrs';

import { WaterQualityAiQueryResponder } from '../water-quality-ai-query.responder';
import { GetSystemWaterQualityStatisticsQuery } from '../../queries/get-system-water-quality-statistics.query';
import { GetTankWaterQualityStatisticsQuery } from '../../queries/get-tank-water-quality-statistics.query';
import { GetWaterQualityChartQuery } from '../../queries/get-water-quality-chart.query';
import { ListCriticalWaterQualityQuery } from '../../queries/list-critical-water-quality.query';
import { ListParameterConfigsQuery } from '../../queries/list-parameter-configs.query';
import { WaterQualityStatsResult } from '../../query-handlers/water-quality-stats.result';
import { WaterQualityMeasurement } from '../../entities/water-quality-measurement.entity';
import { WaterQualityParameterConfig } from '../../entities/water-quality-parameter-config.entity';

const TENANT = '33333333-3333-4333-8333-333333333333';
const TANK = '11111111-1111-4111-8111-111111111111';
const SYSTEM = '22222222-2222-4222-8222-222222222222';

const STATS: WaterQualityStatsResult = {
  avgTemperature: 18.5,
  avgDO: 7.2,
  avgPH: 7.8,
  avgAmmonia: 0.02,
  avgNitrite: null,
  measurementCount: 42,
  criticalCount: 1,
  warningCount: 3,
  lastMeasurement: {
    id: 'm1',
    tankId: TANK,
    measuredAt: new Date('2026-09-01T06:00:00.000Z'),
    temperature: 18.4,
    dissolvedOxygen: 7.1,
    pH: 7.9,
    ammonia: 0.03,
    nitrite: undefined,
    overallStatus: 'warning' as WaterQualityMeasurement['overallStatus'],
    measuredBy: 'operator-user-id', // PII — must never cross the wire
  } as WaterQualityMeasurement,
};

function measurement(overrides: Partial<WaterQualityMeasurement> = {}): WaterQualityMeasurement {
  return {
    id: 'm1',
    tenantId: TENANT,
    tankId: TANK,
    measuredAt: new Date('2026-09-01T06:00:00.000Z'),
    temperature: 18.4,
    dissolvedOxygen: 7.1,
    pH: 7.9,
    ammonia: 0.03,
    nitrite: null,
    overallStatus: 'critical' as WaterQualityMeasurement['overallStatus'],
    hasAlarm: true,
    measuredBy: 'operator-user-id',
    notes: 'operator note',
    ...overrides,
  } as WaterQualityMeasurement;
}

function parameterConfig(
  overrides: Partial<WaterQualityParameterConfig> = {},
): WaterQualityParameterConfig {
  return {
    id: 'c1',
    tenantId: TENANT,
    code: 'temperature',
    name: 'Temperature',
    unit: '°C',
    dataType: 'number' as WaterQualityParameterConfig['dataType'],
    group: 'basic' as WaterQualityParameterConfig['group'],
    optimalMin: 12,
    optimalMax: 18,
    warningMin: null,
    warningMax: 20,
    criticalMin: null,
    criticalMax: 24,
    speciesLimits: { [TANK]: { optimalMin: 8, optimalMax: 14 } },
    isActive: true,
    isVisible: true,
    ...overrides,
  } as WaterQualityParameterConfig;
}

describe('WaterQualityAiQueryResponder (PR-3 farm-AI read surface)', () => {
  let execute: jest.Mock;
  let responder: WaterQualityAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    responder = new WaterQualityAiQueryResponder({ execute } as unknown as QueryBus);
  });

  // ---------------------------------------------------------------- WQ_TANK_STATS
  it('WQ_TANK_STATS: invalid payload → INVALID_REQUEST, no query executed', async () => {
    for (const bad of [
      null,
      [],
      { tenantId: 'nope', tankId: TANK },
      { tenantId: TENANT, tankId: 'tank-1' },
      { tenantId: TENANT, tankId: TANK, days: 0 },
      { tenantId: TENANT, tankId: TANK, days: 91 },
    ]) {
      expect(await responder.tankStats(bad)).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('WQ_TANK_STATS: happy path executes the tenant-scoped query and replies ok', async () => {
    execute.mockResolvedValue(STATS);

    const reply = await responder.tankStats({ tenantId: TENANT, tankId: TANK, days: 30 });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.any(GetTankWaterQualityStatisticsQuery));
    const query = execute.mock.calls[0][0] as GetTankWaterQualityStatisticsQuery;
    expect(query.tenantId).toBe(TENANT);
    expect(query.tankId).toBe(TANK);
    expect(query.days).toBe(30);

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.windowDays).toBe(30);
      expect(reply.data.avgTemperatureC).toBe(18.5);
      expect(reply.data.avgDissolvedOxygenMgL).toBe(7.2);
      expect(reply.data.avgPh).toBe(7.8);
      expect(reply.data.avgNitriteMgL).toBeNull();
      expect(reply.data.lastMeasurement?.measuredAt).toBe('2026-09-01T06:00:00.000Z');
      expect(JSON.stringify(reply.data)).not.toContain('operator-user-id');
      expect(JSON.stringify(reply.data)).not.toContain('measuredBy');
    }
  });

  it('WQ_TANK_STATS: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('connection reset'));
    expect(await responder.tankStats({ tenantId: TENANT, tankId: TANK })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });

  // ------------------------------------------------------------- WQ_SYSTEM_STATS
  it('WQ_SYSTEM_STATS: invalid payload → INVALID_REQUEST, no query executed', async () => {
    expect(await responder.systemStats({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INVALID_REQUEST',
    });
    expect(await responder.systemStats({ tenantId: TENANT, systemId: 'sys', days: 7 })).toEqual({
      ok: false,
      error: 'INVALID_REQUEST',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('WQ_SYSTEM_STATS: happy path executes the query (default 7-day window)', async () => {
    execute.mockResolvedValue({ ...STATS, lastMeasurement: null });

    const reply = await responder.systemStats({ tenantId: TENANT, systemId: SYSTEM });

    expect(execute).toHaveBeenCalledWith(expect.any(GetSystemWaterQualityStatisticsQuery));
    const query = execute.mock.calls[0][0] as GetSystemWaterQualityStatisticsQuery;
    expect(query.tenantId).toBe(TENANT);
    expect(query.systemId).toBe(SYSTEM);
    expect(query.days).toBe(7);
    expect(reply).toMatchObject({ ok: true, data: { windowDays: 7, lastMeasurement: null } });
  });

  it('WQ_SYSTEM_STATS: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.systemStats({ tenantId: TENANT, systemId: SYSTEM })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });

  // ----------------------------------------------------------------- WQ_HISTORY
  it('WQ_HISTORY: invalid payload (bad dates / range > 90d) → INVALID_REQUEST', async () => {
    for (const bad of [
      { tenantId: TENANT, tankId: TANK, fromDate: '2026-01-01', toDate: '2026-12-31' },
      { tenantId: TENANT, tankId: TANK, fromDate: '01-06-2026', toDate: '2026-06-30' },
      { tenantId: TENANT, tankId: TANK, toDate: '2026-06-30' },
      { tenantId: TENANT, tankId: TANK, fromDate: '2026-06-01', toDate: '2026-05-01' },
    ]) {
      expect(await responder.history(bad)).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('WQ_HISTORY: happy path bounds the list and projects ISO dates', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => measurement({ id: `m${i}` }));
    execute.mockResolvedValue(rows);

    const reply = await responder.history({
      tenantId: TENANT,
      tankId: TANK,
      fromDate: '2026-08-01',
      toDate: '2026-09-01',
      limit: 50,
    });

    expect(execute).toHaveBeenCalledWith(expect.any(GetWaterQualityChartQuery));
    const query = execute.mock.calls[0][0] as GetWaterQualityChartQuery;
    expect(query.tenantId).toBe(TENANT);
    expect(query.fromDate).toEqual(new Date('2026-08-01'));
    expect(query.toDate).toEqual(new Date('2026-09-01'));

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.items).toHaveLength(50); // clamped to MAX_LIST_LIMIT
      expect(reply.data.truncated).toBe(true);
      expect(reply.data.total).toBe(60);
      expect(reply.data.items[0]?.measuredAt).toBe('2026-09-01T06:00:00.000Z');
      expect(JSON.stringify(reply.data)).not.toContain('operator note');
    }
  });

  it('WQ_HISTORY: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(
      await responder.history({
        tenantId: TENANT,
        tankId: TANK,
        fromDate: '2026-08-01',
        toDate: '2026-09-01',
      }),
    ).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
  });

  // --------------------------------------------------------------- WQ_CRITICAL
  it('WQ_CRITICAL: invalid payload → INVALID_REQUEST, no query executed', async () => {
    expect(await responder.critical({ tenantId: 'bad' })).toEqual({
      ok: false,
      error: 'INVALID_REQUEST',
    });
    expect(await responder.critical({ tenantId: TENANT, limit: 51 })).toEqual({
      ok: false,
      error: 'INVALID_REQUEST',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('WQ_CRITICAL: happy path wraps rows in the bounded list with tank identity', async () => {
    execute.mockResolvedValue([
      measurement({
        tank: { code: 'TNK-001', name: 'Havuz 1' } as WaterQualityMeasurement['tank'],
      }),
    ]);

    const reply = await responder.critical({ tenantId: TENANT });

    expect(execute).toHaveBeenCalledWith(expect.any(ListCriticalWaterQualityQuery));
    expect((execute.mock.calls[0][0] as ListCriticalWaterQualityQuery).tenantId).toBe(TENANT);
    expect(reply).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            tankId: TANK,
            tankCode: 'TNK-001',
            tankName: 'Havuz 1',
            hasAlarm: true,
            overallStatus: 'critical',
          },
        ],
        truncated: false,
        total: 1,
      },
    });
  });

  it('WQ_CRITICAL: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.critical({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });

  // ------------------------------------------------------------- WQ_THRESHOLDS
  it('WQ_THRESHOLDS: invalid payload → INVALID_REQUEST, no query executed', async () => {
    expect(await responder.thresholds({ tenantId: TENANT, speciesId: 'salmon' })).toEqual({
      ok: false,
      error: 'INVALID_REQUEST',
    });
    expect(await responder.thresholds([TENANT])).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('WQ_THRESHOLDS: happy path lists configs unfiltered and resolves the species override', async () => {
    execute.mockResolvedValue([parameterConfig()]);

    const reply = await responder.thresholds({ tenantId: TENANT, speciesId: TANK });

    expect(execute).toHaveBeenCalledWith(expect.any(ListParameterConfigsQuery));
    const query = execute.mock.calls[0][0] as ListParameterConfigsQuery;
    expect(query.tenantId).toBe(TENANT);
    expect(query.filters).toBeUndefined(); // ParameterConfigFilter has no speciesId

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.items[0]).toMatchObject({
        code: 'temperature',
        unit: '°C',
        optimalMin: 8, // species override won over the global 12
        optimalMax: 14,
        criticalMax: 24,
        isActive: true,
      });
    }

    // without a speciesId the global thresholds pass through
    const globalReply = await responder.thresholds({ tenantId: TENANT });
    expect(globalReply).toMatchObject({
      ok: true,
      data: { items: [{ optimalMin: 12, optimalMax: 18 }] },
    });
  });

  it('WQ_THRESHOLDS: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.thresholds({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });
});
