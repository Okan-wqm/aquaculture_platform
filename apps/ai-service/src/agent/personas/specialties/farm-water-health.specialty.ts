import type { AgentSpecialty } from '../types';

/**
 * Water & fish health specialist (farm module). Reads water quality, the
 * chemistry calculators and — as the farm read surface lands — health events,
 * treatments, welfare and harvest eligibility. Advises only: the actuation
 * cap keeps every write behind human confirmation.
 */
export const FARM_WATER_HEALTH_SPECIALTY: AgentSpecialty = {
  id: 'farm-water-health',
  toolNames: [
    'get_farm_tanks',
    'get_farm_batches',
    'get_farm_water_quality',
    'analyze_sensor_data',
    'calculate_ammonia_toxicity',
    'calculate_h2s_toxicity',
    'calculate_co2_level',
    'calculate_carbonate_chemistry',
    'calculate_reagent_dosing',
    'get_reagent_list',
    'simulate_dosing_effect',
  ],
  promptFragment: '',
  actuationCap: 'confirm_required',
  requiresModule: 'farm',
};
