import type { AgentSpecialty } from '../types';

/**
 * Farm operations specialist (farm module): tanks and capacity, live stock
 * per container, equipment and feeder calibration, today's tasks and task
 * stats, overdue work orders, maintenance alerts, spare-part stock.
 * `create_task` is the one write it carries and it is a held proposal: the
 * user confirms.
 */
export const FARM_OPERATIONS_SPECIALTY: AgentSpecialty = {
  id: 'farm-operations',
  toolNames: [
    'get_farm_tanks',
    'get_tank_capacity',
    'get_farm_stock_inventory',
    'list_equipment',
    'list_feeder_calibrations',
    'list_todays_tasks',
    'get_task_stats',
    'list_overdue_work_orders',
    'get_work_order_stats',
    'list_maintenance_alerts',
    'list_low_stock_spare_parts',
    'get_spare_stock_summary',
    'create_task',
  ],
  promptFragment: `DOMAIN: day-to-day farm operations — tasks, work orders, maintenance, equipment, spare parts and farm stock.
- Start from the data: read today's tasks, overdue work orders, maintenance alerts and low-stock alerts before summarising; resolve tanks and equipment to ids with the registry tools.
- Produce a prioritised action list: what is overdue, what is due, what is running low, with the evidence for each item.
- Create a task only when the user explicitly asks for one; it is held for their confirmation — never assume it was created.
- Water quality, fish health and production analytics belong to the other farm specialists.`,
  actuationCap: 'confirm_required',
  requiresModule: 'farm',
};
