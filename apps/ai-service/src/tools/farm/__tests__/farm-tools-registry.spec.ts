import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ToolRegistryModule } from '../../tool-registry.module';
import { ToolRegistryService } from '../../tool-registry.service';
import { FarmToolsModule } from '../farm-tools.module';
import { ToolExecutionAudit } from '../../../audit/tool-execution-audit.entity';

/**
 * PR-3/PR-4/PR-5 boot-invariant guard: every farm-ai-query tool must be a
 * provider of FarmToolsModule so DiscoveryService registers it — a tool the
 * registry cannot see is a tool the persona can never call (and a specialty
 * referencing it would abort ai-service at boot instead).
 */
const PR3_TOOL_NAMES = [
  'get_tank_water_quality_stats',
  'get_system_water_quality_stats',
  'get_water_quality_history',
  'list_critical_water_quality',
  'get_water_quality_thresholds',
  'get_fish_health_stats',
  'list_health_events',
  'list_critical_health_events',
  'list_overdue_health_follow_ups',
  'list_lice_counts',
  'list_treatment_applications',
  'list_welfare_assessments',
  'check_batch_harvest_eligibility',
];

const PR4_TOOL_NAMES = [
  'get_batch_performance',
  'get_growth_analysis',
  'list_growth_measurements',
  'get_mortality_by_cause',
  'get_transfers_summary',
  'get_daily_feeding_plan',
  'get_feeding_summary',
  'get_site_feed_consumption',
  'list_feeding_protocols',
  'list_species',
  'get_tank_capacity',
  'list_harvest_plans',
  'get_harvest_plan_stats',
  'get_biomass_report',
  'list_regulatory_reports',
  'get_finance_summary',
  'get_finance_batch_totals',
];

const PR5_TOOL_NAMES = [
  'list_equipment',
  'list_feeder_calibrations',
  'list_overdue_work_orders',
  'get_work_order_stats',
  'list_maintenance_alerts',
  'list_low_stock_spare_parts',
  'get_spare_stock_summary',
  'get_farm_stock_inventory',
  'list_todays_tasks',
  'get_task_stats',
];

const ALL_NEW_TOOL_NAMES = [...PR3_TOOL_NAMES, ...PR4_TOOL_NAMES, ...PR5_TOOL_NAMES];

const AUDIT_REPO_STUB = { create: jest.fn(), save: jest.fn(), find: jest.fn() };

describe('FarmToolsModule registry discovery (PR-3/PR-4/PR-5 tools)', () => {
  it('registers all 40 farm-ai-query tools', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ToolRegistryModule, FarmToolsModule],
    })
      .overrideProvider(getRepositoryToken(ToolExecutionAudit))
      .useValue(AUDIT_REPO_STUB)
      // NATS client replaced — discovery must not need a live broker.
      .overrideProvider('NATS_SERVICE')
      .useValue({ send: jest.fn() })
      .compile();
    await moduleRef.init();

    const registry = moduleRef.get(ToolRegistryService);

    for (const name of ALL_NEW_TOOL_NAMES) {
      expect({ name, registered: registry.hasTool(name) }).toEqual({
        name,
        registered: true,
      });
    }

    // 40 new + the 6 pre-existing farm tools.
    expect(registry.size).toBe(46);

    await moduleRef.close();
  });

  it('exposes a Claude tool definition with a JSON input schema for each', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ToolRegistryModule, FarmToolsModule],
    })
      .overrideProvider(getRepositoryToken(ToolExecutionAudit))
      .useValue(AUDIT_REPO_STUB)
      .overrideProvider('NATS_SERVICE')
      .useValue({ send: jest.fn() })
      .compile();
    await moduleRef.init();

    const registry = moduleRef.get(ToolRegistryService);
    const definitions = registry.getClaudeToolDefinitions(ALL_NEW_TOOL_NAMES);

    expect(definitions).toHaveLength(ALL_NEW_TOOL_NAMES.length);
    for (const definition of definitions) {
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.input_schema).toBeDefined();
    }

    await moduleRef.close();
  });
});
