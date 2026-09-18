/**
 * FARM-AI PR-2 Commit A — Water & Health specialty.
 *
 * Bundle starts from the current general water-chemistry calculators (usable
 * day one); PR-3 replaces it with the specialty's real farm-ai-query tool set
 * as those land. Commit B carries the specialty's prompt fragment; persona-parity.spec
 * freezes the joined legacy prompts. Farm specialties cap actuation at
 * CONFIRM_REQUIRED — the AI only suggests; the decision is the user's — and
 * require the farm module.
 */
import type { AgentSpecialty } from './general.specialty';

export const FARM_WATER_HEALTH_SPECIALTY: AgentSpecialty = {
  id: 'farm-water-health',
  toolNames: [
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
