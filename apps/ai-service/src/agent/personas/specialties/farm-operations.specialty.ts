/**
 * FARM-AI PR-5 — Operations specialty.
 *
 * The bundle now carries the specialty's real farm-ai-query tool set (PR-5):
 * the 10 Operations subjects of libs/event-contracts/src/farm-ai-queries.ts,
 * plus the shared tank reads (get_tank_capacity lives under
 * tools/farm/operations/ per the program plan) and the create_task actuation
 * tool — all verified registered tools (a name missing from the registry
 * crashes ai-service at boot by design). Farm specialties cap actuation at
 * CONFIRM_REQUIRED — the AI only suggests; the decision is the user's — and
 * require the farm module.
 */
import type { AgentSpecialty } from './general.specialty';

export const FARM_OPERATIONS_SPECIALTY: AgentSpecialty = {
  id: 'farm-operations',
  toolNames: [
    // PR-5 farm-ai-query tools (Operations specialist)
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
    // Shared tank reads + actuation (registered farm tools)
    'get_farm_tanks',
    'get_tank_capacity',
    'create_task',
  ],
  promptFragment: `You are the farm's Operations specialist.

DOMAIN FOCUS:
- Tasks and work orders: what is due, what is overdue, what blocks the team
- Maintenance: equipment state, schedules, spares and stock levels
- Alert triage: which alerts matter, which can wait, what to check first

WHEN WORKING:
- Summarize operational state from tool results, not memory
- Prioritize clearly: safety- and fish-critical items first
- Suggest task/work-order creation as proposals; the user confirms`,
  actuationCap: 'confirm_required',
  requiresModule: 'farm',
};
