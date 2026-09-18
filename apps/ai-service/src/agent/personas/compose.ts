import type {
  AiPersonaCatalogueEntry,
  AiPersonaTier,
  AiSpecialtyId,
  AiSpecialtyModule,
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
- Never invent a measurement, count, date, cost or threshold. Every figure you state comes from a tool result in this conversation; say which tool it came from. If a tool is unavailable, fails, or returns nothing, say so plainly instead of estimating.`;

/**
 * The decision bullet depends on the tier's actuation ceiling: an advisory
 * tier (blocked / confirm_required) never acts; the autonomous supervisor tier
 * may act within the platform's safety limits and must say when it did. One
 * text per ceiling, so a persona never carries two contradicting bullets.
 */
export const PROMPT_DECISION_ADVISORY = `- You advise; the user decides. You never act on the farm yourself. When a tool call is held for confirmation, tell the user what you proposed and point them to the confirmation card — do not claim it was done.`;
export const PROMPT_DECISION_AUTONOMOUS = `- You may act through your tools within the platform's safety limits. State every action you took and its result; when an action was refused or escalated, say so and never claim it was done.`;

export const PROMPT_POSTAMBLE = `- State uncertainty and your confidence explicitly. Separate what the data shows from what you infer.
- Always respond in the user's language.`;

export function promptContract(actuationCeiling: ActuationPolicy): string {
  const decision =
    actuationCeiling === 'allowed' ? PROMPT_DECISION_AUTONOMOUS : PROMPT_DECISION_ADVISORY;
  return [PROMPT_PREAMBLE, decision, PROMPT_POSTAMBLE].join('\n');
}

/** A runtime persona: the shared `AgentPersona` shape plus its two axes. */
export interface ComposedPersona extends AgentPersona {
  readonly tier: AiPersonaTier;
  readonly specialty: AiSpecialtyId;
  /** RBAC strings the caller must ALL hold (from the shared catalogue). */
  readonly requiredCapabilities: readonly string[];
  /** The specialty's module scope — the only module whose tools this persona may offer. */
  readonly requiresModule: AiSpecialtyModule | null;
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
  const systemPrompt = [
    promptContract(tier.actuationCeiling),
    tier.promptFragment,
    specialty.promptFragment,
  ]
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
    requiresModule: specialty.requiresModule,
  };
}
