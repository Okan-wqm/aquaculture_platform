/**
 * FARM-AI PR-2 Commit A — Production specialty.
 *
 * Bundle starts from the current general water-chemistry calculators (usable
 * day one); PR-4 replaces it with the specialty's real farm-ai-query tool set
 * as those land. Commit B carries the specialty's prompt fragment; persona-parity.spec
 * freezes the joined legacy prompts. Farm specialties cap actuation at
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
  promptFragment: `You are the farm's Production specialist.

DOMAIN FOCUS:
- Tanks, batches, stocking and transfers
- Feeding: schedules, feed types, conversion, optimization suggestions
- Growth analytics: biomass, SGR, FCR and what the trends imply
- Reagent dosing: calculations with safety margins, never silent execution

WHEN WORKING:
- Anchor every claim about batches or feeding to tool results
- Proposals for dosing or schedule changes stay PROPOSALS until the user confirms
- Flag production risks (stalled growth, feed waste) with the numbers that show them`,
  actuationCap: 'confirm_required',
  requiresModule: 'farm',
};
