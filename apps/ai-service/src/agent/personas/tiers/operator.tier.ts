/**
 * FARM-AI PR-2 Commit A — operator tier.
 *
 * The tier fragment is the FULL legacy operator-v1 system prompt, byte-for-byte
 * (persona-parity.spec pins this): composition with an empty PREAMBLE and an
 * empty general-specialty fragment must reproduce the exact pre-PR-2 prompt,
 * so the refactor ships with zero behavioral change. Commit B splits these
 * fragments into shared preamble + tier-specific parts.
 */
export interface AgentTier {
  readonly id: 'operator' | 'manager' | 'expert' | 'supervisor';
  /** Model class for the tier (per-tenant/env overrides applied later). */
  readonly model: string;
  readonly maxTokensPerTurn: number;
  /** Highest actuation privilege the tier may ever reach. */
  readonly actuationCeiling: 'blocked' | 'confirm_required' | 'allowed';
  readonly promptFragment: string;
  /** Short internal name (persona name for general personas — parity-critical). */
  readonly name: string;
  /**
   * Tool gate: may this tier run the named tool at all? Tiers decide ACCESS,
   * specialties decide NEED (compose intersects both).
   */
  readonly tierAllowsTool: (toolName: string) => boolean;
}

const OPERATOR_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'calculate_ammonia_toxicity',
  'calculate_h2s_toxicity',
  'calculate_co2_level',
  'calculate_carbonate_chemistry',
  'get_reagent_list',
]);

export const OPERATOR_TIER: AgentTier = {
  id: 'operator',
  name: 'Operator',
  // FAZ0-BOOT-03: 'claude-haiku-4-5-20250515' was a nonexistent dated ID —
  // every chat request 404'd at the Anthropic API. Aliases track the served
  // model and survive snapshot retirements. Tier intent: operator = fast/cheap
  // triage. Env override: AI_CHAT_MODEL_OVERRIDE (AgentProfileService);
  // per-tenant chatModel override lands with BYOK (Faz 1).
  model: 'claude-haiku-4-5',
  maxTokensPerTurn: 4096,
  actuationCeiling: 'confirm_required',
  promptFragment: `You are an aquaculture operations assistant. You help fish farm operators with:
- Checking water quality parameters (pH, ammonia, CO2, H2S)
- Reading sensor values and understanding their meaning
- Basic water chemistry calculations
- Acknowledging and understanding alerts

Always respond in the user's language. Be concise and practical.
When reporting sensor values, include units and whether they are in safe range.
If a parameter is dangerous, clearly warn the operator.

IMPORTANT: You can only READ data and perform calculations. You cannot change any settings or actuate equipment.
For changes, tell the operator to contact their manager or use the management interface.`,
  tierAllowsTool: (toolName) => OPERATOR_ALLOWED_TOOLS.has(toolName),
};
