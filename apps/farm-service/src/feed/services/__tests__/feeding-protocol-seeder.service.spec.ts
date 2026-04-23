/**
 * FeedingProtocolSeederService Unit Tests
 *
 * Covers:
 *   - default catalogue shape (4 salmon life stages)
 *   - empty tenant → every default is created
 *   - idempotency: `(species, stage)` pairs already present are
 *     skipped (single protocol per stage per species)
 *   - every seeded row carries isActive+isDefault=true,
 *     matching tenantId, and the temperature-curve payload
 */
import { FeedingProtocolSeederService } from '../feeding-protocol-seeder.service';
import type { FeedingProtocol } from '../../entities/feeding-protocol.entity';
import { FeedType } from '../../entities/feed.entity';

interface RepoDouble {
  find: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
}

function makeRepo(
  opts: { existing?: Array<{ species: string; stage: FeedType }> } = {},
): RepoDouble {
  const existing = opts.existing ?? [];
  return {
    find: jest.fn().mockResolvedValue(existing),
    create: jest
      .fn()
      .mockImplementation((row: Partial<FeedingProtocol>) => row as FeedingProtocol),
    save: jest.fn().mockImplementation(async (row: FeedingProtocol) => row),
  };
}

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('FeedingProtocolSeederService', () => {
  it('defaults cover fry / starter / grower / finisher life stages for ATLANTIC_SALMON', () => {
    const svc = new FeedingProtocolSeederService(
      makeRepo() as unknown as import('typeorm').Repository<FeedingProtocol>,
    );
    const defaults = svc.getDefaults();
    const stages = defaults.map((d) => d.stage).sort();
    expect(stages).toEqual(
      [FeedType.FINISHER, FeedType.FRY, FeedType.GROWER, FeedType.STARTER].sort(),
    );
    for (const d of defaults) {
      expect(d.species).toBe('ATLANTIC_SALMON');
      expect(d.targetFcr).toBeGreaterThan(0);
      expect(d.temperatureRanges.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('seeds every default on an empty tenant', async () => {
    const repo = makeRepo({ existing: [] });
    const svc = new FeedingProtocolSeederService(
      repo as unknown as import('typeorm').Repository<FeedingProtocol>,
    );
    const result = await svc.seedDefaults(TENANT);
    expect(result.seeded).toHaveLength(4);
    expect(result.skipped).toEqual([]);
    expect(repo.save).toHaveBeenCalledTimes(4);
    // Every saved row has tenantId + isActive + isDefault true
    for (const call of repo.save.mock.calls) {
      const row = call[0] as FeedingProtocol;
      expect(row.tenantId).toBe(TENANT);
      expect(row.isActive).toBe(true);
      expect(row.isDefault).toBe(true);
      expect(row.temperatureRanges).toBeDefined();
      expect(row.temperatureRanges!.length).toBeGreaterThan(0);
    }
  });

  it('skips (species, stage) pairs the tenant already has', async () => {
    const repo = makeRepo({
      existing: [
        { species: 'ATLANTIC_SALMON', stage: FeedType.GROWER },
        { species: 'ATLANTIC_SALMON', stage: FeedType.FINISHER },
      ],
    });
    const svc = new FeedingProtocolSeederService(
      repo as unknown as import('typeorm').Repository<FeedingProtocol>,
    );
    const result = await svc.seedDefaults(TENANT);
    expect(result.seeded.sort()).toEqual(
      ['ATLANTIC_SALMON:fry', 'ATLANTIC_SALMON:starter'].sort(),
    );
    expect(result.skipped.sort()).toEqual(
      ['ATLANTIC_SALMON:finisher', 'ATLANTIC_SALMON:grower'].sort(),
    );
    expect(repo.save).toHaveBeenCalledTimes(2);
  });

  it('rerun on a fully-seeded tenant is a no-op', async () => {
    const repo = makeRepo({
      existing: [
        { species: 'ATLANTIC_SALMON', stage: FeedType.FRY },
        { species: 'ATLANTIC_SALMON', stage: FeedType.STARTER },
        { species: 'ATLANTIC_SALMON', stage: FeedType.GROWER },
        { species: 'ATLANTIC_SALMON', stage: FeedType.FINISHER },
      ],
    });
    const svc = new FeedingProtocolSeederService(
      repo as unknown as import('typeorm').Repository<FeedingProtocol>,
    );
    const result = await svc.seedDefaults(TENANT);
    expect(result.seeded).toEqual([]);
    expect(result.skipped).toHaveLength(4);
    expect(repo.save).not.toHaveBeenCalled();
  });
});
