/**
 * FARM-AI PR-2 Commit A — Operations specialty.
 *
 * Bundle starts from the current general water-chemistry calculators (usable
 * day one); PR-5 replaces it with the specialty's real farm-ai-query tool set
 * as those land. Commit B carries the specialty's prompt fragment; persona-parity.spec
 * freezes the joined legacy prompts. Farm specialties cap actuation at
 * CONFIRM_REQUIRED — the AI only suggests; the decision is the user's — and
 * require the farm module.
 */
import type { AgentSpecialty } from './general.specialty';

export const FARM_OPERATIONS_SPECIALTY: AgentSpecialty = {
  id: 'farm-operations',
  toolNames: [
    'calculate_ammonia_toxicity',
    'calculate_h2s_toxicity',
    'calculate_co2_level',
    'calculate_carbonate_chemistry',
    'calculate_reagent_dosing',
    'get_reagent_list',
    'simulate_dosing_effect',
  ],
  promptFragment: `You are the farm's Operations specialist.

DOMAIN FOCUS:
- Tasks and work orders: what is due, what is overdue, what blocks the team
- Maintenance: equipment state, schedules, spares and stock levels
- Alert triage: which alerts matter, which can wait, what to check first

WHEN WORKING:
- Summarize operational state from tool results, not memory
- Prioritize clearly: safety- and fish-critical items first
- Suggest task/work-order creation as proposals; the user confirms`,
  actuationCap: 'confirm_required',
  requiresModule: 'farm',
};
