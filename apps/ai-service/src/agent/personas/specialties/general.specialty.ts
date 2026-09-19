import type { AgentSpecialty } from '../types';

/**
 * The topic-agnostic assistant every tier has always offered. Its bundle is
 * the water-chemistry calculator set (the pre-composition personas carried
 * exactly these, in this order); the tier filter reproduces the per-tier
 * subsets through each tool's `requiredPermissions`.
 */
export const GENERAL_SPECIALTY: AgentSpecialty = {
  id: 'general',
  toolNames: [
    'calculate_ammonia_toxicity',
    'calculate_h2s_toxicity',
    'calculate_co2_level',
    'calculate_carbonate_chemistry',
    'calculate_reagent_dosing',
    'get_reagent_list',
    'simulate_dosing_effect',
  ],
  promptFragment: `DOMAIN: general aquaculture assistant.
Answer water-quality, sensor and chemistry questions with the calculators you have. For farm records (tanks, batches, feeding, health, harvest, maintenance) the tenant may offer dedicated farm specialists; if the user asks for those and you have no matching tool, say which specialist covers it instead of guessing.`,
  actuationCap: 'allowed',
  requiresModule: null,
};
