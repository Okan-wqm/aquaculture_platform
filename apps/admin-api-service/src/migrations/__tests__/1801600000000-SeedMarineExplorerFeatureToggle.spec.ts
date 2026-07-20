import { QueryRunner } from 'typeorm';

import { SeedMarineExplorerFeatureToggle1801600000000 } from '../1801600000000-SeedMarineExplorerFeatureToggle';

describe('SeedMarineExplorerFeatureToggle1801600000000', () => {
  it('seeds the canonical key disabled with an explicit empty tenant allowlist', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const runner = { query } as Partial<QueryRunner> as QueryRunner;

    await new SeedMarineExplorerFeatureToggle1801600000000().up(runner);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('"admin"."feature_toggles"');
    expect(sql).toContain("'marine_explorer'");
    expect(sql).toContain("'tenant'");
    expect(sql).toContain("'disabled'");
    expect(sql).toContain('"enabledTenants"');
    expect(sql).toContain("'[]'::jsonb");
    expect(sql).toContain('ON CONFLICT ("key") DO NOTHING');
    expect(sql).toContain("RAISE EXCEPTION 'marine_explorer must be tenant-scoped before rollout'");
    expect(sql).not.toContain('DO UPDATE SET');
  });

  it('down is forward-only and never deletes operator policy data', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const runner = { query } as Partial<QueryRunner> as QueryRunner;

    await new SeedMarineExplorerFeatureToggle1801600000000().down(runner);

    expect(query).not.toHaveBeenCalled();
  });
});
