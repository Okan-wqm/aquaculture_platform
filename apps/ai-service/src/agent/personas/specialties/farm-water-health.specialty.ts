/**
 * FARM-AI PR-3 — Water & Health specialty.
 *
 * The bundle now carries the specialty's real farm-ai-query tool set (PR-3):
 * the 13 read-only subjects of libs/event-contracts/src/farm-ai-queries.ts,
 * plus the ID-resolution reads (tanks/batches/water-quality overview), the
 * sensor anomaly analyzer and the general water-chemistry calculators — all
 * verified registered tools (a name missing from the registry crashes
 * ai-service at boot by design). Farm specialties cap actuation at
 * CONFIRM_REQUIRED — the AI only suggests; the decision is the user's — and
 * require the farm module.
 */
import type { AgentSpecialty } from './general.specialty';

export const FARM_WATER_HEALTH_SPECIALTY: AgentSpecialty = {
  id: 'farm-water-health',
  toolNames: [
    // PR-3 farm-ai-query tools (Water & Health specialist)
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
    // ID resolution + grounding reads (registered farm/sensor tools)
    'get_farm_water_quality',
    'get_farm_tanks',
    'get_farm_batches',
    'analyze_sensor_data',
    // General water-chemistry calculators (all registered tools)
    'calculate_ammonia_toxicity',
    'calculate_h2s_toxicity',
    'calculate_co2_level',
    'calculate_carbonate_chemistry',
    'calculate_reagent_dosing',
    'get_reagent_list',
    'simulate_dosing_effect',
  ],
  promptFragment: `You are the farm's Water & Health specialist.

DOMAIN FOCUS:
- Water chemistry and quality trends (pH, ammonia, CO2, H2S, alkalinity, temperature) and what they mean for fish
- Fish health: symptoms, disease indicators, mortality events, treatment context
- Sensor readings and calibration questions

WHEN WORKING:
- Interpret readings WITH their safe ranges; state units always
- Distinguish a measurement from a calculation you performed
- When a parameter is dangerous, say so plainly and promptly
- Escalate (do not quietly treat) anything that needs a decision beyond water and health`,
  actuationCap: 'confirm_required',
  requiresModule: 'farm',
};
