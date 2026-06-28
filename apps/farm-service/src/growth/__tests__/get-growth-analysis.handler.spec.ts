import { NotFoundException } from '@nestjs/common';

import { createMockDataSource } from '@aquaculture/testing';

import { GetGrowthAnalysisQuery } from '../queries/get-growth-analysis.query';
import { GetGrowthAnalysisHandler } from '../query-handlers/get-growth-analysis.handler';
import type { FCRCalculationService } from '../services/fcr-calculation.service';

describe('GetGrowthAnalysisHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const batchId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const speciesId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  type FcrMock = Pick<FCRCalculationService, 'calculateCumulativeFCR'>;

  const makeFcr = (fcr: number): FcrMock => ({
    calculateCumulativeFCR: jest.fn().mockResolvedValue({
      fcr,
      totalFeed: 100,
      totalGrowth: 60,
      removedBiomassKg: 0,
    }),
  });

  const makeBatch = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: batchId,
    batchNumber: 'B-001',
    speciesId,
    species: undefined,
    weight: { initial: { avgWeight: 10, totalBiomass: 50 } },
    fcr: { target: 1.5 },
    stockedAt: new Date('2026-01-01T00:00:00.000Z'),
    expectedHarvestDate: new Date('2026-12-01T00:00:00.000Z'),
    getDaysInProduction: (): number => 100,
    getCurrentBiomass: (): number => 120,
    getSurvivalRate: (): number => 96,
    ...overrides,
  });

  it('returns the growth analysis read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();

    // Call order: findOne(Batch), findOne(Species), find(GrowthMeasurement)
    (mockManager.findOne as jest.Mock)
      .mockResolvedValueOnce(makeBatch())
      .mockResolvedValueOnce({
        id: speciesId,
        commonName: 'Atlantic Salmon',
        scientificName: 'Salmo salar',
        growthParameters: { avgHarvestWeight: 5000, avgDailyGrowth: 5 },
      });
    (mockManager.find as jest.Mock).mockResolvedValueOnce([
      {
        measurementDate: new Date('2026-02-01T00:00:00.000Z'),
        averageWeight: 40,
        weightCV: 12,
        fcrAnalysis: { periodFCR: 1.4 },
        growthComparison: { specificGrowthRate: 2 },
      },
      {
        measurementDate: new Date('2026-03-01T00:00:00.000Z'),
        averageWeight: 80,
        weightCV: 14,
        fcrAnalysis: { periodFCR: 1.5 },
        growthComparison: { specificGrowthRate: 2.5 },
      },
    ]);

    const fcr = makeFcr(1.6);
    const handler = new GetGrowthAnalysisHandler(mockDataSource, fcr as FCRCalculationService);

    const result = await handler.execute(new GetGrowthAnalysisQuery(tenantId, batchId));

    expect(result.batchId).toBe(batchId);
    expect(result.batchNumber).toBe('B-001');
    expect(result.speciesName).toBe('Atlantic Salmon');
    expect(result.measurementCount).toBe(2);
    expect(result.cumulativeFCR).toBe(1.6);
    expect(result.currentAvgWeightG).toBe(80);
    expect(result.currentBiomassKg).toBe(120);

    // Boundary used: the Batch lookup is scoped by id + tenantId.
    expect(mockManager.findOne).toHaveBeenNthCalledWith(1, expect.anything(), {
      where: { id: batchId, tenantId },
      relations: ['species'],
    });
    expect(fcr.calculateCumulativeFCR).toHaveBeenCalledWith(batchId, tenantId);
  });

  it('uses the batch-attached species without a second findOne', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();

    const batchWithSpecies = makeBatch({
      species: {
        id: speciesId,
        commonName: 'Rainbow Trout',
        growthParameters: { avgHarvestWeight: 4000, avgDailyGrowth: 4 },
      },
    });
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(batchWithSpecies);
    (mockManager.find as jest.Mock).mockResolvedValueOnce([]);

    const handler = new GetGrowthAnalysisHandler(mockDataSource, makeFcr(1.4) as FCRCalculationService);

    const result = await handler.execute(new GetGrowthAnalysisQuery(tenantId, batchId));

    expect(result.speciesName).toBe('Rainbow Trout');
    expect(mockManager.findOne).toHaveBeenCalledTimes(1);
  });

  it('throws NotFoundException when the batch does not exist', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const handler = new GetGrowthAnalysisHandler(mockDataSource, makeFcr(1.5) as FCRCalculationService);

    await expect(
      handler.execute(new GetGrowthAnalysisQuery(tenantId, batchId)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
