/**
 * Tank growth projection handler spec — pins the entity resolution the live
 * path depends on: production tanks are rows in the `tanks` table (Tank
 * entity), NOT the equipment registry. The first live deployment answered
 * every projection with an empty list because the handler looked units up as
 * Equipment; a tank that exists only in equipment must never project, and a
 * real tank must — with capacity straight off the tanks columns.
 */
import { createMockDataSource } from '@aquaculture/testing';

import { ProtocolRateService } from '../../feeding-protocol/services/protocol-rate.service';
import { Tank } from '../../tank/entities/tank.entity';
import { GetTankGrowthProjectionHandler } from '../query-handlers/get-tank-growth-projection.handler';
import { GetTankGrowthProjectionQuery } from '../queries/get-tank-growth-projection.query';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const departmentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const tankId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const protocolId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const assignment = {
  tenantId,
  unitId: tankId,
  unitType: 'TANK',
  unitCode: 'TNK-2026-00012',
  unitName: 'Tank 12',
  siteId,
  departmentId,
  protocolId,
  status: 'active',
  effectiveFrom: new Date(),
  overrides: {},
};

const tank = {
  id: tankId,
  tenantId,
  name: 'Tank 12',
  code: 'TNK-2026-00012',
  departmentId,
  volume: 100,
  maxBiomass: 500,
  maxDensity: 40,
  department: {
    id: departmentId,
    name: 'Departman A',
    site: { id: siteId, name: 'GUI3 Kara RAS Tesis' },
  },
};

const batch = {
  tenantId,
  tankId,
  tankCode: 'TNK-2026-00012',
  totalQuantity: 2830,
  avgWeightG: 95.19,
  totalBiomassKg: 269.38,
};

const protocol = {
  id: protocolId,
  tenantId,
  name: 'GUI3 Standart Protokolü',
  isDeleted: false,
  bands: [
    {
      minWeightG: 50,
      maxWeightG: 250,
      feedingRatePercent: 1.5,
      feedId: 'feed-1',
      expectedFcr: 1.2,
    },
  ],
  temperatureAdjustments: [],
  fcrMatrix: null,
  settings: { minFeedingRatePercent: 0.2, maxFeedingRatePercent: 3 },
};

import type { WaterTemperatureReader } from '../query-handlers/get-tank-growth-projection.handler';

function stubWaterTemperature(celsius: number): WaterTemperatureReader {
  return {
    getEffectiveTemperature: async () => ({ celsius, source: 'manual' }),
  };
}

describe('tank growth projection handler', () => {
  it('projects a stocked tank with an active assignment from the tanks table', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockImplementation(async (entity: unknown) => {
      const name = String(entity);
      if (name.includes('Equipment')) {
        throw new Error('projection must resolve tanks from the tanks table, not equipment');
      }
      if (name.includes('ProtocolAssignment')) return [assignment];
      if (name.includes('TankBatch')) return [batch];
      if (name.includes('FeedingProtocolV2')) return [protocol];
      if (name.includes('Tank')) return [tank];
      return [];
    });

    // Real rate service (pure logic), stubbed water temperature, mock DB.
    const handler = new GetTankGrowthProjectionHandler(
      mockDataSource,
      new ProtocolRateService(),
      stubWaterTemperature(14),
    );

    const rows = await handler.execute(
      new GetTankGrowthProjectionQuery(tenantId, { siteId, horizonDays: 10 }),
    );

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.unitCode).toBe('TNK-2026-00012');
    expect(row.siteName).toBe('GUI3 Kara RAS Tesis');
    expect(row.capacityKg).toBe(500); // straight off tanks.maxBiomass
    expect(row.fishCount).toBe(2830);
    expect(row.currentBiomassKg).toBeCloseTo(269.38, 1);
    expect(row.series).toHaveLength(10);
    // feed × horizon grows the biomass: day 10 is heavier than day 1
    expect(row.projectedBiomassKg).toBeGreaterThan(row.series[0]!.biomassKg);
    expect(row.totalFeedKg).toBeGreaterThan(0);
    expect(row.series[0]!.temperatureC).toBe(14);
  });

  it('scopes by department through the tanks table when requested', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockImplementation(async (entity: unknown) => {
      const name = String(entity);
      if (name.includes('ProtocolAssignment')) return [assignment];
      if (name.includes('TankBatch')) return [batch];
      if (name.includes('FeedingProtocolV2')) return [protocol];
      if (name.includes('Tank')) return [tank];
      return [];
    });
    const handler = new GetTankGrowthProjectionHandler(
      mockDataSource,
      new ProtocolRateService(),
      stubWaterTemperature(14),
    );

    const rows = await handler.execute(
      new GetTankGrowthProjectionQuery(tenantId, {
        siteId,
        departmentId,
        horizonDays: 7,
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.departmentName).toBe('Departman A');

    const other = await handler.execute(
      new GetTankGrowthProjectionQuery(tenantId, {
        siteId,
        departmentId: '11111111-2222-4333-8444-555555555555',
        horizonDays: 7,
      }),
    );
    expect(other).toEqual([]);
  });
});
