import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { QueryBus } from '@platform/cqrs';
import { GetFarmStockInventoryQuery } from '../../queries/get-farm-stock-inventory.query';
import { FarmStockAiQueryResponder } from '../farm-stock-ai-query.responder';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

describe('FarmStockAiQueryResponder (FARM-MEDIUM-328)', () => {
  let execute: jest.Mock;
  let responder: FarmStockAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    const queryBus: Pick<QueryBus, 'execute'> = { execute };
    responder = new FarmStockAiQueryResponder(queryBus as QueryBus);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('projects containers with their batches and forwards the filters', async () => {
    execute.mockResolvedValue({
      items: [
        {
          container: {
            containerId: ID,
            containerSource: 'tank',
            name: 'Tank 3',
            code: 'T-3',
            siteId: ID,
            status: 'active',
            volume: '120',
            maxBiomassKg: 3000,
            currentQuantity: 9000,
            currentBiomassKg: '900.5',
            capacityUsedPercent: 30,
            isOverCapacity: false,
            hasActiveBatch: true,
            isActive: true,
          },
          batches: [
            {
              batchId: ID,
              batchNumber: 'B-1',
              speciesName: 'Seabass',
              quantity: 9000,
              biomassKg: '900.5',
              avgWeightG: 100,
              densityKgM3: 7.5,
              isPrimary: true,
              totalMortality: 12,
            },
          ],
        },
      ],
      total: 1,
      page: 1,
      limit: 10,
    });

    const reply = await responder.getInventory({
      tenantId: TENANT,
      siteId: ID,
      hasActiveBatch: true,
      limit: 10,
    });

    expect(execute).toHaveBeenCalledWith(expect.any(GetFarmStockInventoryQuery));
    const query = execute.mock.calls[0][0] as GetFarmStockInventoryQuery;
    expect(query.filter).toMatchObject({
      isActive: true,
      siteId: ID,
      hasActiveBatch: true,
      page: 1,
      limit: 10,
    });
    expect(reply).toMatchObject({
      ok: true,
      data: {
        total: 1,
        items: [
          {
            code: 'T-3',
            volumeM3: 120,
            currentBiomassKg: 900.5,
            capacityUsedPct: 30,
            isOverCapacity: false,
            batches: [
              {
                batchNumber: 'B-1',
                speciesName: 'Seabass',
                biomassKg: 900.5,
                densityKgM3: 7.5,
                isPrimary: true,
              },
            ],
          },
        ],
      },
    });
  });
});
