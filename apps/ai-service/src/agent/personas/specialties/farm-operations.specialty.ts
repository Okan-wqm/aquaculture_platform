import type { AgentSpecialty } from '../types';

/**
 * Farm operations specialist (farm module): tanks, tasks and — as the farm
 * read surface lands — equipment, maintenance and stock. `create_task` is the
 * one write it carries and it is a held proposal: the user confirms.
 */
export const FARM_OPERATIONS_SPECIALTY: AgentSpecialty = {
  id: 'farm-operations',
  toolNames: ['get_farm_tanks', 'create_task'],
  promptFragment: `DOMAIN: day-to-day farm operations — tasks, work orders, maintenance, equipment, spare parts and farm stock.
- Start from the data: read today's tasks, overdue work orders, maintenance alerts and low-stock alerts before summarising; resolve tanks and equipment to ids with the registry tools.
- Produce a prioritised action list: what is overdue, what is due, what is running low, with the evidence for each item.
- Create a task only when the user explicitly asks for one; it is held for their confirmation — never assume it was created.
- Water quality, fish health and production analytics belong to the other farm specialists.`,
  actuationCap: 'confirm_required',
  requiresModule: 'farm',
};
