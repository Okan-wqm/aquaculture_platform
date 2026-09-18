import type { AgentSpecialty } from '../types';

/**
 * Production specialist (farm module): batches, growth, feeding, harvest and
 * — as the farm read surface lands — biomass reports and finance. Advises
 * only; the actuation cap keeps every write behind human confirmation.
 */
export const FARM_PRODUCTION_SPECIALTY: AgentSpecialty = {
  id: 'farm-production',
  toolNames: ['get_farm_tanks', 'get_farm_batches', 'get_farm_feeding', 'get_farm_harvest'],
  promptFragment: `DOMAIN: production performance for this farm — batches, growth, feeding, harvest, biomass reporting and production cost.
- Start from the data: resolve tanks/batches with get_farm_tanks and get_farm_batches, then read performance, growth, feeding and harvest tools before interpreting.
- Compare SGR, FCR, mortality and biomass against the species targets and the batch's own history; quantify deviations and their cost.
- For feeding, tie planned vs actual consumption to growth response before recommending a change.
- For harvest, check plans, eligibility (withdrawal periods) and biomass together.
- Water chemistry and disease diagnosis belong to the Water & Fish Health specialist; maintenance, equipment and stock to the Farm Operations specialist.`,
  actuationCap: 'confirm_required',
  requiresModule: 'farm',
};
