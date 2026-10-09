/**
 * Every water-quality reader names a measurement's unit through
 * measurement-unit.ts — never by the `tankId` column alone.
 *
 * Since PR-3.0a a non-tank unit (a biofilter, a sump) is filed as
 * `equipmentId` with `tankId` NULL, and the old batch writer filed tanks only
 * as `equipmentId`. A reader keyed on `tankId` dropped all of those rows; the
 * life-safety critical list was one. Each test pins the reader's unit
 * predicate to the shared expression, so a reader reverted to `tankId` fails.
 *
 * London school: the EntityManager's query builder is a recording double.
 */
import { createMockDataSource, stubMember } from '@aquaculture/testing';
import type { EntityManager } from 'typeorm';

import { ListCriticalWaterQualityHandler } from '../query-handlers/list-critical-water-quality.handler';
import { ListCriticalWaterQualityQuery } from '../queries/list-critical-water-quality.query';
import { ListWaterQualityHandler } from '../query-handlers/list-water-quality.handler';
import { ListWaterQualityQuery } from '../queries/list-water-quality.query';
import { GetLatestWaterQualityHandler } from '../query-handlers/get-latest-water-quality.handler';
import { GetLatestWaterQualityQuery } from '../queries/get-latest-water-quality.query';
import { GetWaterQualityChartHandler } from '../query-handlers/get-water-quality-chart.handler';
import { GetWaterQualityChartQuery } from '../queries/get-water-quality-chart.query';
import { GetTankWaterQualityStatisticsHandler } from '../query-handlers/get-tank-water-quality-statistics.handler';
import { GetTankWaterQualityStatisticsQuery } from '../queries/get-tank-water-quality-statistics.query';
import { GetSystemWaterQualityStatisticsHandler } from '../query-handlers/get-system-water-quality-statistics.handler';
import { GetSystemWaterQualityStatisticsQuery } from '../queries/get-system-water-quality-statistics.query';
import { GetSystemWaterQualityChartHandler } from '../query-handlers/get-system-water-quality-chart.handler';
import { GetSystemWaterQualityChartQuery } from '../queries/get-system-water-quality-chart.query';
import {
  measurementUnitIdOf,
  measurementUnitIdSql,
  measurementUnitMatchSql,
} from '../services/measurement-unit-reader';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UNIT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TANK_2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

type Call = [string, ...unknown[]];

interface RecordingBuilder {
  calls: Call[];
  builder: Record<string, (...args: unknown[]) => unknown>;
}

interface Results {
  getOne?: unknown;
  getMany?: unknown[];
  getRawOne?: unknown;
  getManyAndCount?: [unknown[], number];
  getQuery?: string;
}

/** A query builder whose every chained call is recorded; terminals return `results`. */
function recordingBuilder(results: Results = {}): RecordingBuilder {
  const calls: Call[] = [];
  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
    'innerJoin',
    'leftJoinAndSelect',
    'setParameters',
    'orderBy',
    'take',
    'skip',
  ]) {
    builder[method] = (...args: unknown[]): unknown => {
      calls.push([method, ...args]);
      return builder;
    };
  }
  builder.getOne = async (): Promise<unknown> => results.getOne ?? null;
  builder.getMany = async (): Promise<unknown[]> => results.getMany ?? [];
  builder.getRawOne = async (): Promise<unknown> => results.getRawOne ?? {};
  builder.getManyAndCount = async (): Promise<[unknown[], number]> =>
    results.getManyAndCount ?? [[], 0];
  builder.getQuery = (): string => results.getQuery ?? 'SUBQUERY';
  builder.getParameters = (): Record<string, unknown> => ({ tenantId: TENANT });
  return { calls, builder };
}

/** A data source whose manager hands out `builders` in order. */
function dataSourceWith(...builders: RecordingBuilder[]): ReturnType<typeof createMockDataSource> {
  const harness = createMockDataSource();
  const queue = [...builders];
  harness.mockManager.createQueryBuilder.mockImplementation(
    stubMember<EntityManager['createQueryBuilder']>(() => {
      const next = queue.shift();
      if (!next) throw new Error('unexpected createQueryBuilder call');
      return next.builder;
    }),
  );
  return harness;
}

describe('measurement-unit reader helpers', () => {
  it('name a row’s unit as its tank, else its equipment', () => {
    expect(measurementUnitIdOf({ tankId: UNIT, equipmentId: undefined })).toBe(UNIT);
    expect(measurementUnitIdOf({ tankId: undefined, equipmentId: UNIT })).toBe(UNIT);
    expect(measurementUnitIdOf({ tankId: UNIT, equipmentId: TANK_2 })).toBe(UNIT);
    expect(measurementUnitIdOf({ tankId: undefined, equipmentId: undefined })).toBeUndefined();
  });

  it('write the coalesce and its index-friendly equivalent over quoted columns', () => {
    expect(measurementUnitIdSql('wq')).toBe('COALESCE("wq"."tankId", "wq"."equipmentId")');
    expect(measurementUnitMatchSql('wq', '= :unitId')).toBe(
      '("wq"."tankId" = :unitId OR ("wq"."tankId" IS NULL AND "wq"."equipmentId" = :unitId))',
    );
  });
});

describe('Water-quality readers identify a measurement by its unit', () => {
  it('the critical list takes the latest row per unit, equipment rows included', async () => {
    const latest = recordingBuilder({ getQuery: 'LATEST' });
    const outer = recordingBuilder({ getMany: [{ id: 'wq-1' }] });
    const { mockDataSource } = dataSourceWith(latest, outer);

    await expect(
      new ListCriticalWaterQualityHandler(mockDataSource).execute(
        new ListCriticalWaterQualityQuery(TENANT),
      ),
    ).resolves.toEqual([{ id: 'wq-1' }]);

    const unitId = measurementUnitIdSql('wq');
    expect(latest.calls).toContainEqual(['addSelect', unitId, 'unitId']);
    expect(latest.calls).toContainEqual(['groupBy', unitId]);
    expect(latest.calls).toContainEqual(['andWhere', `${unitId} IS NOT NULL`]);
    const join = outer.calls.find(([method]) => method === 'innerJoin');
    expect(join?.[1]).toBe('(LATEST)');
    expect(join?.[3]).toContain(`${measurementUnitIdSql('measurement')} = "latest"."unitId"`);
    expect(join?.[3]).toContain('"latest"."maxDate"');
    expect(JSON.stringify([...latest.calls, ...outer.calls])).not.toMatch(/\.tankId/);
  });

  it('the list filters unitId and tankId by unit, and pages the result', async () => {
    const list = recordingBuilder({ getManyAndCount: [[{ id: 'wq-1' }], 1] });
    const { mockDataSource } = dataSourceWith(list);

    const result = await new ListWaterQualityHandler(mockDataSource).execute(
      new ListWaterQualityQuery(TENANT, { unitId: UNIT, tankId: UNIT, limit: 50, offset: 0 }),
    );

    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(list.calls).toContainEqual(['where', 'wq.tenantId = :tenantId', { tenantId: TENANT }]);
    expect(list.calls).toContainEqual([
      'andWhere',
      measurementUnitMatchSql('wq', '= :unitId'),
      { unitId: UNIT },
    ]);
    expect(list.calls).toContainEqual([
      'andWhere',
      measurementUnitMatchSql('wq', '= :tankId'),
      { tankId: UNIT },
    ]);
  });

  it('the list matches a system’s tanks by unit', async () => {
    const list = recordingBuilder();
    const { mockDataSource, mockManager } = dataSourceWith(list);
    mockManager.find.mockResolvedValueOnce([{ id: UNIT }, { id: TANK_2 }]);

    await new ListWaterQualityHandler(mockDataSource).execute(
      new ListWaterQualityQuery(TENANT, { systemId: UNIT }),
    );

    expect(list.calls).toContainEqual([
      'andWhere',
      measurementUnitMatchSql('wq', 'IN (:...systemUnitIds)'),
      { systemUnitIds: [UNIT, TANK_2] },
    ]);
  });

  it('latest, chart and per-unit statistics match the unit', async () => {
    const latest = recordingBuilder({ getOne: { id: 'wq-latest' } });
    const chart = recordingBuilder();
    const stats = recordingBuilder({ getRawOne: { measurementCount: '2' } });
    const last = recordingBuilder();
    const { mockDataSource } = dataSourceWith(latest, chart, stats, last);
    const match = measurementUnitMatchSql('wq', '= :unitId');

    await expect(
      new GetLatestWaterQualityHandler(mockDataSource).execute(
        new GetLatestWaterQualityQuery(TENANT, UNIT),
      ),
    ).resolves.toEqual({ id: 'wq-latest' });
    await new GetWaterQualityChartHandler(mockDataSource).execute(
      new GetWaterQualityChartQuery(TENANT, UNIT, new Date(0), new Date()),
    );
    const result = await new GetTankWaterQualityStatisticsHandler(mockDataSource).execute(
      new GetTankWaterQualityStatisticsQuery(TENANT, UNIT, 7),
    );

    expect(result.measurementCount).toBe(2);
    for (const recording of [latest, chart, stats, last]) {
      expect(recording.calls).toContainEqual(['andWhere', match, { unitId: UNIT }]);
    }
  });

  it('system statistics and chart match the system’s tanks by unit', async () => {
    const stats = recordingBuilder({ getRawOne: { measurementCount: '0' } });
    const last = recordingBuilder();
    const chart = recordingBuilder();
    const { mockDataSource, mockManager } = dataSourceWith(stats, last, chart);
    mockManager.find.mockResolvedValue([{ id: UNIT }, { id: TANK_2 }]);
    const match = measurementUnitMatchSql('wq', 'IN (:...unitIds)');

    await new GetSystemWaterQualityStatisticsHandler(mockDataSource).execute(
      new GetSystemWaterQualityStatisticsQuery(TENANT, 'system-1', 7),
    );
    await new GetSystemWaterQualityChartHandler(mockDataSource).execute(
      new GetSystemWaterQualityChartQuery(TENANT, 'system-1', new Date(0), new Date()),
    );

    for (const recording of [stats, last, chart]) {
      expect(recording.calls).toContainEqual(['andWhere', match, { unitIds: [UNIT, TANK_2] }]);
    }
  });
});
