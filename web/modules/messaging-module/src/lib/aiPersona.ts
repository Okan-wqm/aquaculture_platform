/**
 * AI persona display names (FAZ 2.4 — AI visibility).
 *
 * `channel.aiPersona` is a persona ID ('expert-v1', …), not a display string.
 * The panel does not run the `availableAiPersonas` query, so the ID→name
 * mirror below keeps the chat author line human-readable. It intentionally
 * mirrors aquamobil's PERSONA_METADATA names (AiChatPage) so both surfaces
 * call the same persona the same thing; unknown IDs fall back to the raw ID
 * (still better than hiding the persona) and missing personas to the caller's
 * generic 'AI Assistant' label. Display-only — never used for routing or
 * authorization.
 */
const AI_PERSONA_NAMES: Record<string, string> = {
  general: 'General AI Assistant',
  'operator-v1': 'Water Quality Specialist',
  'expert-v1': 'Farm Expert',
  'manager-v1': 'Management Assistant',
  'supervisor-v1': 'SCADA AI',
};

/**
 * Display name for a channel's AI persona. Empty/null personas return null so
 * the caller falls back to its generic AI label (t('messaging.aiAssistant')).
 */
export function aiPersonaDisplayName(aiPersona: string | null | undefined): string | null {
  if (!aiPersona) return null;
  return AI_PERSONA_NAMES[aiPersona] ?? aiPersona;
}
