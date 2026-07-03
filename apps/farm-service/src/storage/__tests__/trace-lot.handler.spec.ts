import { createMockDataSource } from '@aquaculture/testing';

import { TraceLotQuery } from '../queries/trace-lot.query';
import { TraceLotHandler } from '../handlers/trace-lot.handler';
import { LotMixService } from '../services/lot-mix.service';
import { StorageLotMix } from '../entities/storage-lot-mix.entity';

describe('TraceLotHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('traces only the lot itself when it never mixed (legacy path)', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const lotMixService = new LotMixService();
    jest.spyOn(lotMixService, 'findMixesForLot').mockResolvedValue([]);
    (mockManager.find as jest.Mock).mockResolvedValueOnce([{ id: 'mv-1' }]);

    const handler = new TraceLotHandler(mockDataSource, lotMixService);
    const result = await handler.execute(new TraceLotQuery('LOT-A', tenantId));

    expect(result).toEqual([{ id: 'mv-1' }]);
    // The mix resolution runs on the boundary connection's manager.
    expect(lotMixService.findMixesForLot).toHaveBeenCalledWith(mockManager, tenantId, 'LOT-A');
    const findArgs = (mockManager.find as jest.Mock).mock.calls[0][1];
    expect(findArgs.where.tenantId).toBe(tenantId);
    expect(findArgs.order).toEqual({ performedAt: 'ASC' });
  });

  it('expands the search to composite mix lot numbers', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const lotMixService = new LotMixService();
    const mix = new StorageLotMix();
    mix.effectiveLotNumber = 'MIX-LOT-A-LOT-B';
    jest.spyOn(lotMixService, 'findMixesForLot').mockResolvedValue([mix]);
    (mockManager.find as jest.Mock).mockResolvedValueOnce([{ id: 'mv-1' }, { id: 'mv-2' }]);

    const handler = new TraceLotHandler(mockDataSource, lotMixService);
    const result = await handler.execute(new TraceLotQuery('LOT-A', tenantId));

    expect(result).toHaveLength(2);
    const findArgs = (mockManager.find as jest.Mock).mock.calls[0][1];
    // In(['LOT-A', 'MIX-LOT-A-LOT-B']) — the In operator wraps the value array.
    expect(findArgs.where.lotNumber._value).toEqual(['LOT-A', 'MIX-LOT-A-LOT-B']);
  });
});
