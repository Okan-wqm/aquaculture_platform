/**
 * Migration shape spec — the production-plan temperature scenario tables.
 */
import type { QueryRunner } from 'typeorm';
import { CreateTemperatureScenarios1823000000000 } from '../1823000000000-CreateTemperatureScenarios';
import { stub } from '@aquaculture/testing';

describe('CreateTemperatureScenarios1823000000000', () => {
  it('creates both tables with the lookup indexes and the cascade FK', async () => {
    const queries: string[] = [];
    const mockQueryRunner = stub<QueryRunner>({
      query: async (sql: string) => {
        queries.push(sql);
      },
    });

    await new CreateTemperatureScenarios1823000000000().up(mockQueryRunner);

    const scenarios = queries.find((q) =>
      q.includes('CREATE TABLE IF NOT EXISTS "temperature_scenarios"'),
    );
    const points = queries.find((q) =>
      q.includes('CREATE TABLE IF NOT EXISTS "temperature_scenario_points"'),
    );
    expect(scenarios).toBeDefined();
    expect(points).toBeDefined();
    expect(scenarios).toContain('"siteId" uuid NOT NULL');
    expect(scenarios).toContain("'manual'");
    expect(points).toContain('"celsius" real NOT NULL');

    const idx = queries.find((q) => q.includes('IDX_temperature_scenario_points_lookup'));
    expect(idx).toContain('"tenantId", "scenarioId", "date"');

    const fk = queries.find((q) => q.includes('FK_temperature_scenario_points_scenario'));
    expect(fk).toContain('ON DELETE CASCADE');
    expect(fk).toContain('pg_constraint');

    // Idempotent DDL: both creates are IF NOT EXISTS
    expect(scenarios).toContain('IF NOT EXISTS');
    expect(points).toContain('IF NOT EXISTS');
  });

  it('drops points before scenarios on down (FK order)', async () => {
    const order: string[] = [];
    const mockQueryRunner = stub<QueryRunner>({
      query: async (sql: string) => {
        order.push(sql);
      },
    });

    await new CreateTemperatureScenarios1823000000000().down(mockQueryRunner);
    expect(order[0]).toContain('temperature_scenario_points');
    expect(order[1]).toContain('"temperature_scenarios"');
  });
});
