import { createMockDataSource } from '@aquaculture/testing';

import { GetHarvestStatisticsQuery } from '../../queries/get-harvest-statistics.query';
import { GetHarvestStatisticsHandler } from '../../handlers/get-harvest-statistics.handler';
import {
  HarvestRecord,
  HarvestRecordStatus,
  QualityGrade,
} from '../../entities/harvest-record.entity';

describe('GetHarvestStatisticsHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const dateRange = {
    startDate: new Date('2026-01-01T00:00:00.000Z'),
    endDate: new Date('2026-03-01T00:00:00.000Z'),
  };

  const makeQb = (rows: unknown[]) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  });

  it('aggregates harvest statistics read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const rows: Array<Partial<HarvestRecord>> = [
      {
        quantityHarvested: 100,
        totalBiomass: 300,
        totalRevenue: 1500,
        averageWeight: 3,
        status: HarvestRecordStatus.IN_PROGRESS,
        qualityGrade: QualityGrade.GRADE_A,
        harvestDate: new Date('2026-01-15T00:00:00.000Z'),
      },
      {
        quantityHarvested: 50,
        totalBiomass: 200,
        totalRevenue: 1000,
        averageWeight: 4,
        status: HarvestRecordStatus.IN_PROGRESS,
        qualityGrade: QualityGrade.GRADE_B,
        harvestDate: new Date('2026-02-10T00:00:00.000Z'),
      },
    ];
    const qb = makeQb(rows);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new GetHarvestStatisticsHandler(mockDataSource);
    const result = await handler.execute(
      new GetHarvestStatisticsQuery(tenantId, dateRange),
    );

    expect(qb.where).toHaveBeenCalledWith('harvest.tenantId = :tenantId', { tenantId });
    expect(result.tenantId).toBe(tenantId);
    expect(result.summary.totalHarvests).toBe(2);
    expect(result.summary.totalQuantityHarvested).toBe(150);
    expect(result.summary.totalBiomassKg).toBe(500);
    expect(result.summary.totalRevenue).toBe(2500);
    expect(result.summary.averagePricePerKg).toBeCloseTo(5);
    expect(result.byStatus).toHaveLength(1);
    expect(result.byQualityGrade).toHaveLength(2);
    expect(result.byMonth).toHaveLength(2);
  });

  it('returns zeroed statistics when there are no harvests', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([]);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new GetHarvestStatisticsHandler(mockDataSource);
    const result = await handler.execute(
      new GetHarvestStatisticsQuery(tenantId, dateRange),
    );

    expect(result.summary.totalHarvests).toBe(0);
    expect(result.summary.averageWeight).toBe(0);
    expect(result.summary.averagePricePerKg).toBe(0);
    expect(result.byStatus).toHaveLength(0);
    expect(result.byMonth).toHaveLength(0);
  });
});
