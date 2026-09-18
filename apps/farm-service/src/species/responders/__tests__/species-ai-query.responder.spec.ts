import 'reflect-metadata';

import { QueryBus } from '@platform/cqrs';

import { SpeciesAiQueryResponder } from '../species-ai-query.responder';
import { ListSpeciesQuery } from '../../queries/list-species.query';
import { Species } from '../../entities/species.entity';

const TENANT = '33333333-3333-4333-8333-333333333333';

function species(id: string): Species {
  return {
    id,
    tenantId: TENANT,
    scientificName: 'Dicentrarchus labrax',
    commonName: 'European Seabass',
    localName: 'Levrek',
    code: 'SEABASS',
    officialCode: 'DL',
    description: 'species description',
    category: 'warm_water' as Species['category'],
    waterType: 'saltwater' as Species['waterType'],
    family: 'Moronidae',
    genus: 'Dicentrarchus',
    optimalConditions: { temperature: { optimal: 22 } } as Species['optimalConditions'],
    growthParameters: { avgSGR: 1.4 } as Species['growthParameters'],
    status: 'active' as Species['status'],
    isActive: true,
    notes: 'operator note',
  } as Species;
}

describe('SpeciesAiQueryResponder (PR-4 farm-AI read surface)', () => {
  let execute: jest.Mock;
  let responder: SpeciesAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    responder = new SpeciesAiQueryResponder({ execute } as unknown as QueryBus);
  });

  it('SPECIES_LIST: invalid payload → INVALID_REQUEST, no query executed', async () => {
    for (const bad of [null, {}, { tenantId: 'nope' }, [TENANT]]) {
      expect(await responder.list(bad)).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('SPECIES_LIST: happy path bounds the catalogue and strips JSONB blobs', async () => {
    execute.mockResolvedValue({
      data: Array.from({ length: 40 }, (_, i) => species(`sp${i}`)),
      pagination: { page: 1, limit: 20, total: 40, totalPages: 2, hasNextPage: true, hasPreviousPage: false },
    });

    const reply = await responder.list({ tenantId: TENANT });

    expect(execute).toHaveBeenCalledWith(expect.any(ListSpeciesQuery));
    expect((execute.mock.calls[0][0] as ListSpeciesQuery).tenantId).toBe(TENANT);

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.items).toHaveLength(20); // DEFAULT_LIST_LIMIT
      expect(reply.data.truncated).toBe(true);
      expect(reply.data.total).toBe(40);
      expect(reply.data.items[0]?.code).toBe('SEABASS');
      expect(JSON.stringify(reply.data)).not.toContain('optimalConditions');
      expect(JSON.stringify(reply.data)).not.toContain('growthParameters');
      expect(JSON.stringify(reply.data)).not.toContain('operator note');
    }
  });

  it('SPECIES_LIST: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(await responder.list({ tenantId: TENANT })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
  });
});
