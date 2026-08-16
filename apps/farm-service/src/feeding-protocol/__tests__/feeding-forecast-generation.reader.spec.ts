import {
  findActiveFeedingForecastSnapshotsV1,
  loadFeedingForecastStockPoolV1,
} from '../feeding-forecast-generation.reader';
import { compileFeedingForecastMortalityProvenanceV1 } from '@aquaculture/feeding-contracts';

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('loadFeedingForecastStockPoolV1', () => {
  it('projects only tenant-qualified, live-location feed stock', async () => {
    const query = jest
      .fn()
      .mockResolvedValue([{ siteId: 'site-a', feedId: 'feed-a', totalKg: '12.5' }]);
    const manager = { query };

    await expect(loadFeedingForecastStockPoolV1(manager, TENANT)).resolves.toEqual([
      { siteId: 'site-a', feedId: 'feed-a', totalKg: 12.5 },
    ]);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('sl.tenant_id = si.tenant_id');
    expect(sql).toContain('sl.is_deleted = false');
    expect(sql).toContain('si.tenant_id = $1');
    expect(sql).toContain("si.item_type = 'feed'");
    expect(query).toHaveBeenCalledWith(expect.any(String), [TENANT]);
  });

  it('fails closed on malformed or negative aggregate rows', async () => {
    for (const totalKg of ['not-a-number', '-1']) {
      const manager = {
        query: jest.fn().mockResolvedValue([{ siteId: 'site-a', feedId: 'feed-a', totalKg }]),
      };
      await expect(loadFeedingForecastStockPoolV1(manager, TENANT)).rejects.toThrow(
        /invalid qualified inventory row/,
      );
    }
  });
});

describe('findActiveFeedingForecastSnapshotsV1 mortality provenance boundary', () => {
  it('rejects an active legacy global boolean instead of projecting ambiguous coverage', async () => {
    const manager = {
      query: jest.fn().mockResolvedValue([
        {
          poolScope: 'TENANT',
          perUnit: [{ unitId: 'unit-a' }, { unitId: 'unit-b' }],
          mortalityAssumption: { applied: true, source: 'species_survival_rate' },
        },
      ]),
    };

    await expect(findActiveFeedingForecastSnapshotsV1(manager, TENANT)).rejects.toThrow(
      /not unit-addressable/,
    );
  });

  it('admits only provenance covering the active snapshot exact unit set', async () => {
    const provenance = compileFeedingForecastMortalityProvenanceV1([
      { unitId: 'unit-a', source: 'species_survival_rate', dailySurvivalRate: 0.99 },
      { unitId: 'unit-b', source: 'none', dailySurvivalRate: 1 },
    ]);
    const row = {
      poolScope: 'TENANT',
      perUnit: [{ unitId: 'unit-a' }, { unitId: 'unit-b' }],
      mortalityAssumption: provenance,
    };
    const manager = { query: jest.fn().mockResolvedValue([row]) };

    await expect(findActiveFeedingForecastSnapshotsV1(manager, TENANT)).resolves.toEqual([row]);
  });
});
