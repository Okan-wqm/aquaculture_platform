/**
 * FARM-AI PR-2 Commit A — general specialty.
 *
 * Bundle starts from the platform's existing water-chemistry calculators (the
 * exact union of the four legacy personas' defaultToolNames; the operator tier
 * gates the two dosing-class tools out via tierAllowsTool). The prompt
 * fragment is EMPTY in Commit A so legacy prompts stay byte-identical under
 * composition; Commit B introduces the shared PREAMBLE and real fragments.
 */
import type { AiSpecialtyId } from '@aquaculture/shared-contracts';

export interface AgentSpecialty {
  readonly id: AiSpecialtyId;
  /** Domain tools the specialty NEEDS (the tier still gates access). */
  readonly toolNames: readonly string[];
  /** Specialty-specific prompt fragment (empty = contributes nothing). */
  readonly promptFragment: string;
  /** Highest actuation privilege the specialty may ever reach. */
  readonly actuationCap: 'blocked' | 'confirm_required' | 'allowed';
  /** Tenant module entitlement the specialty's tools depend on. */
  readonly requiresModule: 'farm' | null;
}

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
