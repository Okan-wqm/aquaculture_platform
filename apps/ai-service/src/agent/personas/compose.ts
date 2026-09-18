import type {
  AiPersonaCatalogueEntry,
  AiPersonaTier,
  AiSpecialtyId,
} from '@aquaculture/shared-contracts';
import type { ActuationPolicy } from '../../tools/core/tool.interface';
import type { AgentPersona, AgentSpecialty, AgentTier } from './types';

/**
 * Prompt text shared by every composed persona, placed before the tier and
 * specialty fragments. It states the operating contract the product commits
 * to: tools only, no web, no invented figures, advise — the user decides.
 */
export const PROMPT_PREAMBLE = `OPERATING CONTRACT
- You have no web access and no memory beyond this conversation. You work ONLY through the tools you are given and the results they return.
- Never invent a measurement, count, date, cost or threshold. Every figure you state comes from a tool result in this conversation; say which tool it came from. If a tool is unavailable, fails, or returns nothing, say so plainly instead of estimating.
- You advise; the user decides. You never act on the farm yourself. When a tool call is held for confirmation, tell the user what you proposed and point them to the confirmation card — do not claim it was done.
- State uncertainty and your confidence explicitly. Separate what the data shows from what you infer.
- Always respond in the user's language.`;

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
    name: entry.name,
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
