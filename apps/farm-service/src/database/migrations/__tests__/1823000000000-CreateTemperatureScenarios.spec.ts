/**
 * Migration shape spec — the production-plan temperature scenario tables.
 * London-school: fully-typed `jest.Mocked<QueryRunner>` from
 * createMockDataSource, no casts, no live DB.
 */
import type { QueryRunner } from 'typeorm';
import { createMockDataSource } from '@aquaculture/testing';

import { CreateTemperatureScenarios1823000000000 } from '../1823000000000-CreateTemperatureScenarios';

describe('CreateTemperatureScenarios1823000000000', () => {
  let mockQueryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner } = createMockDataSource());
    mockQueryRunner.query.mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  function queries(): string[] {
    return mockQueryRunner.query.mock.calls.map((call) => String(call[0]));
  }

  it('creates both tables with the lookup indexes and the replay-safe cascade FK', async () => {
    await new CreateTemperatureScenarios1823000000000().up(mockQueryRunner);

    const all = queries();
    const scenarios = all.find((q) =>
      q.includes('CREATE TABLE IF NOT EXISTS "temperature_scenarios"'),
    );
    const points = all.find((q) =>
      q.includes('CREATE TABLE IF NOT EXISTS "temperature_scenario_points"'),
    );
    expect(scenarios).toBeDefined();
    expect(points).toBeDefined();
    expect(scenarios).toContain('"siteId" uuid NOT NULL');
    expect(scenarios).toContain("'manual'");
    expect(points).toContain('"celsius" real NOT NULL');

    const idx = all.find((q) => q.includes('IDX_temperature_scenario_points_lookup'));
    expect(idx).toContain('"tenantId", "scenarioId", "date"');

    const fk = all.find((q) => q.includes('FK_temperature_scenario_points_scenario'));
    expect(fk).toContain('ON DELETE CASCADE');
    expect(fk).toContain('pg_constraint');
  });

  it('drops points before scenarios on down (FK order)', async () => {
    await new CreateTemperatureScenarios1823000000000().down(mockQueryRunner);
    const order = queries();
    expect(order[0]).toContain('temperature_scenario_points');
    expect(order[1]).toContain('"temperature_scenarios"');
  });
});
