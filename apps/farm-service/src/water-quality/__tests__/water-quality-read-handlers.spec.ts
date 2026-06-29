/**
 * Water-quality read query handlers — fail-closed tenant boundary
 * (FARM-HIGH-076 / FARM-HIGH-060). Proves tenant scoping, fail-closed NotFound,
 * and empty-system short-circuits read through runInTenantRead.
 */
import { NotFoundException } from '@nestjs/common';
import { createMockDataSource } from '@aquaculture/testing';

import { GetWaterQualityHandler } from '../query-handlers/get-water-quality.handler';
import { GetWaterQualityQuery } from '../queries/get-water-quality.query';
import { GetLatestWaterQualityHandler } from '../query-handlers/get-latest-water-quality.handler';
import { GetLatestWaterQualityQuery } from '../queries/get-latest-water-quality.query';
import { ListWaterQualityHandler } from '../query-handlers/list-water-quality.handler';
import { ListWaterQualityQuery } from '../queries/list-water-quality.query';
import { GetSystemWaterQualityChartHandler } from '../query-handlers/get-system-water-quality-chart.handler';
import { GetSystemWaterQualityChartQuery } from '../queries/get-system-water-quality-chart.query';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('Water-quality read handlers (fail-closed tenant boundary)', () => {
  describe('GetWaterQualityHandler', () => {
    it('returns the measurement scoped to the tenant (with tank relation)', async () => {
      const { mockDataSource, mockManager } = createMockDataSource();
      (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: 'wq-1' });

      const result = await new GetWaterQualityHandler(mockDataSource).execute(
        new GetWaterQualityQuery(tenantId, 'wq-1'),
      );

      expect(result).toEqual({ id: 'wq-1' });
      expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
        where: { id: 'wq-1', tenantId },
        relations: ['tank'],
      });
    });

    it('throws NotFoundException when absent (no silent null)', async () => {
      const { mockDataSource, mockManager } = createMockDataSource();
      (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

      await expect(
        new GetWaterQualityHandler(mockDataSource).execute(
          new GetWaterQualityQuery(tenantId, 'missing'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('GetLatestWaterQualityHandler', () => {
    it('reads the latest measurement for the tank, tenant-scoped', async () => {
      const { mockDataSource, mockManager } = createMockDataSource();
      (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: 'wq-latest' });

      const result = await new GetLatestWaterQualityHandler(mockDataSource).execute(
        new GetLatestWaterQualityQuery(tenantId, 'tank-1'),
      );

      expect(result).toEqual({ id: 'wq-latest' });
      expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
        where: { tenantId, tankId: 'tank-1' },
        order: { measuredAt: 'DESC' },
      });
    });
  });

  describe('ListWaterQualityHandler', () => {
    it('lists tenant-scoped measurements with paginated result', async () => {
      const { mockDataSource, mockManager } = createMockDataSource();
      (mockManager.findAndCount as jest.Mock).mockResolvedValueOnce([[{ id: 'wq-1' }], 1]);

      const result = await new ListWaterQualityHandler(mockDataSource).execute(
        new ListWaterQualityQuery(tenantId, { tankId: 'tank-1', limit: 50, offset: 0 }),
      );

      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      const [, opts] = (mockManager.findAndCount as jest.Mock).mock.calls[0];
      expect(opts.where).toMatchObject({ tenantId, tankId: 'tank-1' });
    });
  });

  describe('GetSystemWaterQualityChartHandler', () => {
    it('returns [] when the system has no tanks (no cross-schema leak)', async () => {
      const { mockDataSource, mockManager } = createMockDataSource();
      (mockManager.find as jest.Mock).mockResolvedValueOnce([]); // tank lookup → none

      const result = await new GetSystemWaterQualityChartHandler(mockDataSource).execute(
        new GetSystemWaterQualityChartQuery(tenantId, 'system-1', new Date(0), new Date()),
      );

      expect(result).toEqual([]);
    });
  });
});
