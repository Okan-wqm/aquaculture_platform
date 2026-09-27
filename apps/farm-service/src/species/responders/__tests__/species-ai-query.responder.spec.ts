import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { QueryBus } from '@platform/cqrs';
import { ListSpeciesQuery } from '../../queries/list-species.query';
import { SpeciesAiQueryResponder } from '../species-ai-query.responder';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

describe('SpeciesAiQueryResponder (FARM-MEDIUM-328)', () => {
  let execute: jest.Mock;
  let responder: SpeciesAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    const queryBus: Pick<QueryBus, 'execute'> = { execute };
    responder = new SpeciesAiQueryResponder(queryBus as QueryBus);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('rejects a malformed payload before touching the query bus', async () => {
    const reply = await responder.listSpecies({ tenantId: 'nope' });
    expect(reply).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('lists active species with their growth targets (numbers or null), bounded and counted', async () => {
    execute.mockResolvedValue({
      data: [
        {
          id: ID,
          code: 'TROUT',
          commonName: 'Rainbow trout',
          scientificName: 'Oncorhynchus mykiss',
          category: 'fish',
          waterType: 'freshwater',
          isActive: true,
          growthParameters: {
            maxDensity: 40,
            optimalDensity: 25,
            avgDailyGrowth: '1.8',
            avgHarvestWeight: 350,
            avgTimeToHarvestDays: 240,
            targetFCR: 1.1,
            maxFCR: 1.4,
            expectedSurvivalRate: 92,
          },
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          code: 'BASS',
          commonName: 'Sea bass',
          scientificName: 'Dicentrarchus labrax',
          category: 'fish',
          waterType: 'seawater',
          isActive: true,
          growthParameters: undefined,
        },
      ],
      pagination: {
        page: 1,
        limit: 50,
        total: 2,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });

    const reply = await responder.listSpecies({ tenantId: TENANT });

    const query = execute.mock.calls[0]?.[0] as ListSpeciesQuery;
    expect(query).toBeInstanceOf(ListSpeciesQuery);
    expect(query.tenantId).toBe(TENANT);
    expect(query.filter).toMatchObject({ isActive: true, limit: 50, offset: 0 });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.data.items[0]).toEqual({
      id: ID,
      code: 'TROUT',
      commonName: 'Rainbow trout',
      scientificName: 'Oncorhynchus mykiss',
      category: 'fish',
      waterType: 'freshwater',
      isActive: true,
      maxDensityKgM3: 40,
      optimalDensityKgM3: 25,
      avgDailyGrowthG: 1.8,
      avgHarvestWeightG: 350,
      avgTimeToHarvestDays: 240,
      targetFcr: 1.1,
      maxFcr: 1.4,
      expectedSurvivalRatePct: 92,
    });
    expect(reply.data.items[1]).toMatchObject({
      code: 'BASS',
      targetFcr: null,
      maxDensityKgM3: null,
    });
    expect(reply.data).toMatchObject({ truncated: false, total: 2 });
  });

  it('turns a query failure into INTERNAL_ERROR (never a throw into the reply channel)', async () => {
    execute.mockRejectedValue(new Error('db down'));
    const reply = await responder.listSpecies({ tenantId: TENANT });
    expect(reply).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
  });
});
