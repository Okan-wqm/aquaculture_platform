import type { AgentSpecialty } from '../types';

/**
 * Farm operations specialist (farm module): tanks, tasks and — as the farm
 * read surface lands — equipment, maintenance and stock. `create_task` is the
 * one write it carries and it is a held proposal: the user confirms.
 */
export const FARM_OPERATIONS_SPECIALTY: AgentSpecialty = {
  id: 'farm-operations',
  toolNames: ['get_farm_tanks', 'create_task'],
  promptFragment: '',
  actuationCap: 'confirm_required',
  requiresModule: 'farm',
};
