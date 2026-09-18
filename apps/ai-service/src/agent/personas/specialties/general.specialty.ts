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
  promptFragment: '',
  actuationCap: 'allowed',
  requiresModule: null,
};
