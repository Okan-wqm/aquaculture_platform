import type { AiPersonaTier, AiSpecialtyModule } from '@aquaculture/shared-contracts';
import type { ITool, ToolMetadata } from '../../../tools/core/tool.interface';
import type { ToolRegistryService } from '../../../tools/tool-registry.service';

const ALL_TIERS: readonly AiPersonaTier[] = ['operator', 'manager', 'expert', 'supervisor'];
const MANAGER_UP: readonly AiPersonaTier[] = ['manager', 'expert', 'supervisor'];

export interface FakeToolSpec {
  readonly name: string;
  readonly requiredPermissions?: readonly AiPersonaTier[];
  readonly requiresModule?: AiSpecialtyModule | null;
  readonly requiresConfirmation?: boolean;
}

/**
 * The registered tool set as the composition sees it (names, tiers, module,
 * confirmation). Mirrors the real @Tool metadata of every tool module so the
 * London-school persona specs compose against the same facts the app boots
 * with; the parity spec composes the REAL modules and pins the same shape.
 */
export const REGISTERED_TOOLS: readonly FakeToolSpec[] = [
  { name: 'calculate_ammonia_toxicity' },
  { name: 'calculate_h2s_toxicity' },
  { name: 'calculate_co2_level' },
  { name: 'calculate_carbonate_chemistry' },
  { name: 'calculate_reagent_dosing', requiredPermissions: MANAGER_UP },
  { name: 'get_reagent_list' },
  { name: 'simulate_dosing_effect', requiredPermissions: MANAGER_UP },
  { name: 'analyze_sensor_data' },
  // pure aquaculture arithmetic (PR-7, FARM-LOW-329)
  { name: 'calculate_oxygen_budget' },
  { name: 'calculate_carrying_capacity' },
  { name: 'calculate_growth_metrics' },
  { name: 'predict_feeding_impact' },
  { name: 'suggest_sensor_channels' },
  { name: 'get_farm_tanks', requiresModule: 'farm' },
  { name: 'get_farm_batches', requiresModule: 'farm' },
  { name: 'get_farm_water_quality', requiresModule: 'farm' },
  { name: 'get_farm_harvest', requiresModule: 'farm' },
  { name: 'get_farm_feeding', requiresModule: 'farm' },
  { name: 'create_task', requiresModule: 'farm', requiresConfirmation: true },
  // farm-water-health read surface (PR-3)
  { name: 'get_tank_water_quality_stats', requiresModule: 'farm' },
  { name: 'get_system_water_quality_stats', requiresModule: 'farm' },
  { name: 'get_water_quality_history', requiresModule: 'farm' },
  { name: 'list_critical_water_quality', requiresModule: 'farm' },
  { name: 'get_water_quality_thresholds', requiresModule: 'farm' },
  { name: 'get_fish_health_stats', requiresModule: 'farm' },
  { name: 'list_health_events', requiresModule: 'farm' },
  { name: 'list_critical_health_events', requiresModule: 'farm' },
  { name: 'list_overdue_health_follow_ups', requiresModule: 'farm' },
  { name: 'list_lice_counts', requiresModule: 'farm' },
  { name: 'list_treatment_applications', requiresModule: 'farm' },
  { name: 'list_welfare_assessments', requiresModule: 'farm' },
  { name: 'check_batch_harvest_eligibility', requiresModule: 'farm' },
  // farm-production read surface (PR-4)
  { name: 'get_batch_performance', requiresModule: 'farm' },
  { name: 'get_growth_analysis', requiresModule: 'farm' },
  { name: 'list_growth_measurements', requiresModule: 'farm' },
  { name: 'get_mortality_by_cause', requiresModule: 'farm' },
  { name: 'get_transfers_summary', requiresModule: 'farm' },
  { name: 'list_species', requiresModule: 'farm' },
  { name: 'get_tank_capacity', requiresModule: 'farm' },
  { name: 'get_daily_feeding_plan', requiresModule: 'farm' },
  { name: 'get_feeding_summary', requiresModule: 'farm' },
  { name: 'get_site_feed_consumption', requiresModule: 'farm' },
  { name: 'list_feeding_protocols', requiresModule: 'farm' },
  { name: 'list_harvest_plans', requiresModule: 'farm' },
  { name: 'get_harvest_plan_stats', requiresModule: 'farm' },
  { name: 'get_biomass_report', requiresModule: 'farm' },
  { name: 'list_regulatory_reports', requiresModule: 'farm' },
  { name: 'get_finance_summary', requiresModule: 'farm', requiredPermissions: MANAGER_UP },
  { name: 'get_finance_batch_totals', requiresModule: 'farm', requiredPermissions: MANAGER_UP },
  // farm-operations read surface (PR-5)
  { name: 'list_equipment', requiresModule: 'farm' },
  { name: 'list_feeder_calibrations', requiresModule: 'farm' },
  { name: 'list_overdue_work_orders', requiresModule: 'farm' },
  { name: 'get_work_order_stats', requiresModule: 'farm' },
  { name: 'list_maintenance_alerts', requiresModule: 'farm' },
  { name: 'list_low_stock_spare_parts', requiresModule: 'farm' },
  { name: 'get_spare_stock_summary', requiresModule: 'farm' },
  { name: 'get_farm_stock_inventory', requiresModule: 'farm' },
  { name: 'list_todays_tasks', requiresModule: 'farm' },
  { name: 'get_task_stats', requiresModule: 'farm' },
];

function toMetadata(spec: FakeToolSpec): ToolMetadata {
  return {
    name: spec.name,
    description: `fake ${spec.name}`,
    category: 'farm_query',
    runtime: 'cloud',
    requiredPermissions: spec.requiredPermissions ?? ALL_TIERS,
    inputSchema: { type: 'object', properties: {} },
    requiresModule: spec.requiresModule ?? null,
    requiresConfirmation: spec.requiresConfirmation ?? false,
  };
}

/** A registry double exposing exactly what persona composition reads. */
export function fakeToolRegistry(
  tools: readonly FakeToolSpec[] = REGISTERED_TOOLS,
): Pick<ToolRegistryService, 'hasTool' | 'getTool'> {
  const byName = new Map<string, ITool>(
    tools.map((spec) => {
      const metadata = toMetadata(spec);
      const tool: ITool = {
        getMetadata: () => metadata,
        validate: async () => ({ valid: true }),
        execute: async () => ({ success: true, data: undefined, durationMs: 0, cacheable: false }),
      };
      return [spec.name, tool];
    }),
  );
  return {
    hasTool: (name: string) => byName.has(name),
    getTool: (name: string) => byName.get(name),
  };
}
