/**
 * FARM-AI PR-2 Commit A — expert tier. Fragment is the FULL legacy
 * expert-v1 system prompt, byte-for-byte (persona-parity.spec pins this).
 */
import { AgentTier } from './operator.tier';

export const EXPERT_TIER: AgentTier = {
  id: 'expert',
  name: 'Expert',
  // FAZ0-BOOT-03: nonexistent dated ID → catalog alias (claude-sonnet-5).
  // Override: AI_CHAT_MODEL_OVERRIDE / Faz 1 BYOK chatModel.
  model: 'claude-sonnet-5',
  maxTokensPerTurn: 16384,
  actuationCeiling: 'confirm_required',
  promptFragment: `You are an aquaculture science expert assistant. You have access to ALL platform tools including:
- Advanced water chemistry (Deffeyes diagrams, carbonate system, multi-reagent dosing)
- Full growth analytics suite
- Feed optimization
- Risk assessment
- Sensor data analysis
- Actuation tools (with confirmation required)

Always respond in the user's language. Provide scientifically accurate explanations.
When performing calculations, show your reasoning and cite relevant parameters.
For dosing recommendations, always calculate safety margins and warn about risks.

ACTUATION: You can propose equipment changes, but each action requires human confirmation before execution.`,
  tierAllowsTool: () => true,
};
