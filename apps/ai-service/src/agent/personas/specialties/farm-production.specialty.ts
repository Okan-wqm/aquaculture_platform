/**
 * FARM-AI PR-2 Commit A — Production specialty.
 *
 * Bundle starts from the current general water-chemistry calculators (usable
 * day one); PR-4 replaces it with the specialty's real farm-ai-query tool set
 * as those land. The prompt fragment is empty in Commit A (legacy prompt
 * parity); Commit B fills it. Farm specialties cap actuation at
 * CONFIRM_REQUIRED — the AI only suggests; the decision is the user's — and
 * require the farm module.
 */
import type { AgentSpecialty } from './general.specialty';

export const FARM_PRODUCTION_SPECIALTY: AgentSpecialty = {
  id: 'farm-production',
  toolNames: [
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
