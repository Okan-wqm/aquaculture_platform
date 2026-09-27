import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { QueryBus } from '@platform/cqrs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { GetTankWaterQualityStatisticsQuery } from '../../queries/get-tank-water-quality-statistics.query';
import { ListWaterQualityQuery } from '../../queries/list-water-quality.query';
import { ListCriticalWaterQualityQuery } from '../../queries/list-critical-water-quality.query';
import { ListParameterConfigsQuery } from '../../queries/list-parameter-configs.query';
import type { WaterQualityMeasurement } from '../../entities/water-quality-measurement.entity';
import { WaterQualityAiQueryResponder } from '../water-quality-ai-query.responder';

const TENANT = '11111111-1111-4111-8111-111111111111';
const TANK = '22222222-2222-4222-8222-222222222222';

function measurement(overrides: Partial<WaterQualityMeasurement> = {}): WaterQualityMeasurement {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    tenantId: TENANT,
    tankId: TANK,
    measuredAt: new Date('2026-09-18T06:00:00Z'),
    parameters: {
      temperature: 14.2,
      dissolvedOxygen: 8.1,
      oxygenSaturation: 92,
      pH: 7.6,
      salinity: 30,
    },
    temperature: 14.2,
    dissolvedOxygen: 8.1,
    pH: 7.6,
    overallStatus: 'warning',
    summary: {
      overallStatus: 'warning',
      criticalCount: 0,
      warningCount: 1,
      optimalCount: 3,
      evaluations: [
        { parameter: 'dissolvedOxygen', value: 8.1, unit: 'mg/L', status: 'optimal' },
        { parameter: 'ammonia', value: 0.9, unit: 'mg/L', status: 'high', criticalMax: 1.2 },
      ],
      recommendations: ['increase aeration'],
    },
    hasAlarm: false,
    measuredBy: 'user-77',
    ...overrides,
  } as WaterQualityMeasurement;
}

describe('WaterQualityAiQueryResponder (FARM-MEDIUM-328)', () => {
  let execute: jest.Mock;
  let responder: WaterQualityAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    const queryBus: Pick<QueryBus, 'execute'> = { execute };
    responder = new WaterQualityAiQueryResponder(queryBus as QueryBus);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  describe(FARM_AI_QUERY_SUBJECTS.WQ_TANK_STATS, () => {
    it('rejects a malformed payload without touching the query bus', async () => {
      const reply = await responder.getTankStats({
        tenantId: TENANT,
        tankId: 'not-a-uuid',
        days: 7,
      });
      expect(reply).toEqual({ ok: false, error: 'INVALID_REQUEST' });
      expect(execute).not.toHaveBeenCalled();
    });

    it('dispatches the tenant-pinned statistics query and projects unit-suffixed averages', async () => {
      execute.mockResolvedValue({
        avgTemperature: 14.25,
        avgDO: '8.05',
        avgPH: 7.6,
        avgAmmonia: null,
        avgNitrite: null,
        measurementCount: 12,
        criticalCount: 0,
        warningCount: 2,
        lastMeasurement: measurement(),
      });

      const reply = await responder.getTankStats({ tenantId: TENANT, tankId: TANK, days: 7 });

      expect(execute).toHaveBeenCalledWith(expect.any(GetTankWaterQualityStatisticsQuery));
      const query = execute.mock.calls[0][0] as GetTankWaterQualityStatisticsQuery;
      expect(query).toMatchObject({ tenantId: TENANT, tankId: TANK, days: 7 });
      expect(reply).toMatchObject({
        ok: true,
        data: {
          scopeId: TANK,
          days: 7,
          measurementCount: 12,
          avgTemperatureC: 14.25,
          avgDoMgL: 8.05,
          avgAmmoniaMgL: null,
          lastMeasurement: {
            measuredAt: '2026-09-18T06:00:00.000Z',
            temperatureC: 14.2,
            doSaturationPct: 92,
            salinityPpt: 30,
            overallStatus: 'warning',
          },
        },
      });
      // No operator identity crosses the contract.
      expect(JSON.stringify(reply)).not.toContain('user-77');
    });

    it('maps a rejected query to INTERNAL_ERROR', async () => {
      execute.mockRejectedValue(new Error('boom'));
      const reply = await responder.getTankStats({ tenantId: TENANT, tankId: TANK, days: 7 });
      expect(reply).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
    });
  });

  describe(FARM_AI_QUERY_SUBJECTS.WQ_HISTORY, () => {
    it('rejects a window wider than the contract cap', async () => {
      const reply = await responder.getHistory({
        tenantId: TENANT,
        tankId: TANK,
        fromDate: '2026-01-01',
        toDate: '2026-09-18',
        limit: 20,
      });
      expect(reply).toEqual({ ok: false, error: 'INVALID_REQUEST' });
      expect(execute).not.toHaveBeenCalled();
    });

    it('reads a DB-bounded newest-first page (full rows incl. parameters) through the whole toDate day', async () => {
      // The list query returns the page the DB already ordered and bounded.
      execute.mockResolvedValue({
        items: [
          measurement({ measuredAt: new Date('2026-09-18T23:30:00Z') }),
          measurement({ measuredAt: new Date('2026-09-17T06:00:00Z') }),
        ],
        total: 3,
        page: 1,
        limit: 2,
        totalPages: 2,
        hasNextPage: true,
        hasPreviousPage: false,
      });

      const reply = await responder.getHistory({
        tenantId: TENANT,
        tankId: TANK,
        fromDate: '2026-09-10',
        toDate: '2026-09-18',
        limit: 2,
      });

      expect(execute).toHaveBeenCalledWith(expect.any(ListWaterQualityQuery));
      const query = execute.mock.calls[0]?.[0] as ListWaterQualityQuery;
      expect(query.filters).toMatchObject({ tankId: TANK, limit: 2, offset: 0 });
      // toDate is a calendar day: the bound is the END of 2026-09-18 (UTC).
      expect(query.filters.toDate?.toISOString()).toBe('2026-09-18T23:59:59.999Z');
      expect(reply.ok).toBe(true);
      if (!reply.ok) return;
      expect(reply.data.items.map((m) => m.measuredAt)).toEqual([
        '2026-09-18T23:30:00.000Z',
        '2026-09-17T06:00:00.000Z',
      ]);
      expect(reply.data).toMatchObject({ truncated: true, total: 3 });
    });
  });

  describe(FARM_AI_QUERY_SUBJECTS.WQ_CRITICAL, () => {
    it('projects only the non-optimal parameters of each critical reading', async () => {
      execute.mockResolvedValue([measurement()]);

      const reply = await responder.listCritical({ tenantId: TENANT, limit: 10 });

      expect(execute).toHaveBeenCalledWith(expect.any(ListCriticalWaterQualityQuery));
      expect(reply).toMatchObject({
        ok: true,
        data: {
          items: [
            {
              tankId: TANK,
              overallStatus: 'warning',
              criticalParameters: [
                {
                  parameter: 'ammonia',
                  value: 0.9,
                  unit: 'mg/L',
                  status: 'high',
                  criticalMin: null,
                  criticalMax: 1.2,
                },
              ],
            },
          ],
          truncated: false,
        },
      });
    });
  });

  describe(FARM_AI_QUERY_SUBJECTS.WQ_THRESHOLDS, () => {
    it('lists active parameter configurations with their limits', async () => {
      execute.mockResolvedValue([
        {
          code: 'nh3',
          name: 'Ammonia',
          unit: 'mg/L',
          group: 'nitrogen',
          optimalMin: 0,
          optimalMax: 0.02,
          warningMax: 0.05,
          criticalMax: 0.1,
        },
      ]);

      const reply = await responder.getThresholds({ tenantId: TENANT, group: 'nitrogen' });

      expect(execute).toHaveBeenCalledWith(expect.any(ListParameterConfigsQuery));
      const query = execute.mock.calls[0][0] as ListParameterConfigsQuery;
      expect(query.filters).toEqual({ isActive: true, group: 'nitrogen' });
      expect(reply).toMatchObject({
        ok: true,
        data: {
          items: [
            { code: 'nh3', unit: 'mg/L', optimalMax: 0.02, warningMin: null, criticalMax: 0.1 },
          ],
        },
      });
    });
  });
});
