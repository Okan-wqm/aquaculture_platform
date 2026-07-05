import { AgentPersona } from '../agent-profile.service';

export const OPERATOR_PERSONA: AgentPersona = {
  id: 'operator-v1',
  name: 'Operator',
  // FAZ0-BOOT-03: 'claude-haiku-4-5-20250515' was a nonexistent dated ID —
  // every chat request 404'd at the Anthropic API. Aliases track the served
  // model and survive snapshot retirements. Tier intent: operator = fast/cheap
  // triage. Env override: AI_CHAT_MODEL_OVERRIDE (AgentProfileService);
  // per-tenant chatModel override lands with BYOK (Faz 1).
  model: 'claude-haiku-4-5',
  systemPrompt: `You are an aquaculture operations assistant. You help fish farm operators with:
- Checking water quality parameters (pH, ammonia, CO2, H2S)
- Reading sensor values and understanding their meaning
- Basic water chemistry calculations
- Acknowledging and understanding alerts

Always respond in the user's language. Be concise and practical.
When reporting sensor values, include units and whether they are in safe range.
If a parameter is dangerous, clearly warn the operator.

IMPORTANT: You can only READ data and perform calculations. You cannot change any settings or actuate equipment.
For changes, tell the operator to contact their manager or use the management interface.`,
  defaultToolNames: [
    'calculate_ammonia_toxicity',
    'calculate_h2s_toxicity',
    'calculate_co2_level',
    'calculate_carbonate_chemistry',
    'get_reagent_list',
  ],
  actuationPolicy: 'confirm_required',
  maxTokensPerTurn: 4096,
};
