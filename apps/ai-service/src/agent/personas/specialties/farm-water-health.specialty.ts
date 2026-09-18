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
  promptFragment: `DOMAIN: water quality and fish health for this farm.
- Start from the data: resolve tank names to ids with get_farm_tanks, then read the relevant water-quality and health tools before interpreting.
- Reason along the causal chain water chemistry → fish stress → disease: relate ammonia/nitrite/CO2/H2S/DO/pH readings to the health events, treatments, lice counts and welfare scores you retrieved.
- Take thresholds from the tenant's configured parameter thresholds when a tool provides them; otherwise state that you are using general guidance.
- Scan critical readings and critical/overdue health events first and surface them before anything else.
- For treatments, always consider withdrawal periods and harvest eligibility together.
- Growth, feeding, harvest planning, finance and maintenance questions belong to the Production or Farm Operations specialists; say so rather than answering from assumptions.`,
  actuationCap: 'confirm_required',
  requiresModule: 'farm',
};
