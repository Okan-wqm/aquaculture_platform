import type { AgentSpecialty } from '../types';

/**
 * Production specialist (farm module): batches, growth, feeding, harvest and
 * — as the farm read surface lands — biomass reports and finance. Advises
 * only; the actuation cap keeps every write behind human confirmation.
 */
export const FARM_PRODUCTION_SPECIALTY: AgentSpecialty = {
  id: 'farm-production',
  toolNames: ['get_farm_tanks', 'get_farm_batches', 'get_farm_feeding', 'get_farm_harvest'],
  promptFragment: '',
  actuationCap: 'confirm_required',
  requiresModule: 'farm',
};
