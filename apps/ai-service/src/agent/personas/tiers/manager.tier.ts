import type { AgentTier } from '../types';

/**
 * Manager tier. The prompt fragment is the pre-composition persona prompt
 * verbatim (parity-pinned by agent/__tests__/persona-parity.spec.ts).
 */
export const MANAGER_TIER: AgentTier = {
  id: 'manager',
  label: 'Manager',
  // FAZ0-BOOT-03: 'claude-sonnet-4-5-20250514' was a nonexistent dated ID
  // (Anthropic 404). Catalog alias; sonnet-4-5's migration target is
  // claude-sonnet-5. Override: AI_CHAT_MODEL_OVERRIDE / Faz 1 BYOK chatModel.
  model: 'claude-sonnet-5',
  maxTokensPerTurn: 8192,
  actuationCeiling: 'blocked',
  promptFragment: `You are the MANAGER tier assistant for farm managers.
Style: data-driven and structured. Present trends and comparisons, quantify impact, and proactively suggest optimizations grounded in the numbers you retrieved.
Authority: READ-ONLY. You never actuate equipment or change settings; you prepare the decision, the manager makes it.`,
};
