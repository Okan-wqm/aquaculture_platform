/**
 * SpeciesSeederService Unit Tests
 *
 * Covers:
 *   - default catalogue shape (Atlantic Salmon + 2 cleaner-fish)
 *   - empty tenant → every default is created
 *   - idempotency: codes already present are skipped
 *   - returned seeded / skipped lists match what was persisted
 *   - cleaner-fish entries carry the cleanerFishType discriminator
 */
import { SpeciesSeederService } from '../species-seeder.service';
import type { Species } from '../../entities/species.entity';
import { SpeciesStatus } from '../../entities/species.entity';

interface RepoDouble {
  find: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
}

function makeRepo(opts: { existingCodes?: string[] } = {}): RepoDouble {
  const existing = (opts.existingCodes ?? []).map((code) => ({ code }));
  return {
    find: jest.fn().mockResolvedValue(existing),
    create: jest.fn().mockImplementation((row: Partial<Species>) => row as Species),
    save: jest.fn().mockImplementation(async (row: Species) => row),
  };
}

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('SpeciesSeederService', () => {
  it('exposes the default catalogue via getDefaults()', () => {
    const svc = new SpeciesSeederService(
      makeRepo() as unknown as import('typeorm').Repository<Species>,
    );
    const defaults = svc.getDefaults();
    const codes = defaults.map((d) => d.code).sort();
    expect(codes).toEqual(['ATLANTIC_SALMON', 'BALLAN_WRASSE', 'LUMPFISH']);
    // Cleaner-fish flag invariant
    const cleaners = defaults.filter((d) => d.isCleanerFish);
    expect(cleaners.map((c) => c.cleanerFishType).sort()).toEqual([
      'lumpfish',
      'wrasse',
    ]);
  });

  it('seeds every default on an empty tenant', async () => {
    const repo = makeRepo({ existingCodes: [] });
    const svc = new SpeciesSeederService(
      repo as unknown as import('typeorm').Repository<Species>,
    );
    const result = await svc.seedDefaults(TENANT);
    expect(result.seeded.sort()).toEqual([
      'ATLANTIC_SALMON',
      'BALLAN_WRASSE',
      'LUMPFISH',
    ]);
    expect(result.skipped).toEqual([]);
    expect(repo.save).toHaveBeenCalledTimes(3);
    // Every saved row has tenantId + ACTIVE + isActive=true
    for (const call of repo.save.mock.calls) {
      const row = call[0] as Species;
      expect(row.tenantId).toBe(TENANT);
      expect(row.status).toBe(SpeciesStatus.ACTIVE);
      expect(row.isActive).toBe(true);
      expect(row.isDeleted).toBe(false);
    }
  });

  it('skips codes the tenant already has (idempotent)', async () => {
    const repo = makeRepo({ existingCodes: ['ATLANTIC_SALMON'] });
    const svc = new SpeciesSeederService(
      repo as unknown as import('typeorm').Repository<Species>,
    );
    const result = await svc.seedDefaults(TENANT);
    expect(result.seeded.sort()).toEqual(['BALLAN_WRASSE', 'LUMPFISH']);
    expect(result.skipped).toEqual(['ATLANTIC_SALMON']);
    expect(repo.save).toHaveBeenCalledTimes(2);
  });

  it('second run on a fully-seeded tenant is a no-op', async () => {
    const repo = makeRepo({
      existingCodes: ['ATLANTIC_SALMON', 'LUMPFISH', 'BALLAN_WRASSE'],
    });
    const svc = new SpeciesSeederService(
      repo as unknown as import('typeorm').Repository<Species>,
    );
    const result = await svc.seedDefaults(TENANT);
    expect(result.seeded).toEqual([]);
    expect(result.skipped.sort()).toEqual([
      'ATLANTIC_SALMON',
      'BALLAN_WRASSE',
      'LUMPFISH',
    ]);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('cleaner-fish rows carry the correct cleanerFishType after save', async () => {
    const repo = makeRepo();
    const svc = new SpeciesSeederService(
      repo as unknown as import('typeorm').Repository<Species>,
    );
    await svc.seedDefaults(TENANT);
    const byCode: Record<string, Species> = {};
    for (const call of repo.save.mock.calls) {
      const row = call[0] as Species;
      byCode[row.code] = row;
    }
    expect(byCode['ATLANTIC_SALMON']!.isCleanerFish).toBe(false);
    expect(byCode['ATLANTIC_SALMON']!.cleanerFishType).toBeUndefined();
    expect(byCode['LUMPFISH']!.isCleanerFish).toBe(true);
    expect(byCode['LUMPFISH']!.cleanerFishType).toBe('lumpfish');
    expect(byCode['BALLAN_WRASSE']!.isCleanerFish).toBe(true);
    expect(byCode['BALLAN_WRASSE']!.cleanerFishType).toBe('wrasse');
  });
});
