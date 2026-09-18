import type {
  AiPersonaCatalogueEntry,
  AiPersonaTier,
  AiSpecialtyId,
} from '@aquaculture/shared-contracts';
import type { ActuationPolicy } from '../../tools/core/tool.interface';
import type { AgentPersona, AgentSpecialty, AgentTier } from './types';

/**
 * Prompt text shared by every composed persona, placed before the tier and
 * specialty fragments. Empty until the prompt restructure commit lands, so
 * the composition is provably byte-identical to the pre-composition personas.
 */
export const PROMPT_PREAMBLE = '';

/** A runtime persona: the shared `AgentPersona` shape plus its two axes. */
export interface ComposedPersona extends AgentPersona {
  readonly tier: AiPersonaTier;
  readonly specialty: AiSpecialtyId;
  /** RBAC strings the caller must ALL hold (from the shared catalogue). */
  readonly requiredCapabilities: readonly string[];
}

const POLICY_RANK: Readonly<Record<ActuationPolicy, number>> = {
  blocked: 0,
  confirm_required: 1,
  allowed: 2,
};

/** Most restrictive wins. */
export function mostRestrictivePolicy(a: ActuationPolicy, b: ActuationPolicy): ActuationPolicy {
  return POLICY_RANK[a] <= POLICY_RANK[b] ? a : b;
}

/**
 * Compose one runtime persona from a catalogue entry, its tier and its
 * specialty. `tierAllowsTool` answers from tool metadata
 * (`requiredPermissions` contains the tier), which is also what the executor
 * enforces — one vocabulary for "may this tier run this tool".
 */
export function composePersona(
  entry: AiPersonaCatalogueEntry,
  tier: AgentTier,
  specialty: AgentSpecialty,
  tierAllowsTool: (toolName: string) => boolean,
): ComposedPersona {
  const systemPrompt = [PROMPT_PREAMBLE, tier.promptFragment, specialty.promptFragment]
    .filter((fragment) => fragment.length > 0)
    .join('\n\n');
  return {
    id: entry.id,
    name: specialty.id === 'general' ? tier.label : entry.name,
    model: tier.model,
    systemPrompt,
    defaultToolNames: specialty.toolNames.filter(tierAllowsTool),
    actuationPolicy: mostRestrictivePolicy(tier.actuationCeiling, specialty.actuationCap),
    maxTokensPerTurn: tier.maxTokensPerTurn,
    tier: tier.id,
    specialty: specialty.id,
    requiredCapabilities: entry.requiredCapabilities,
  };
}
