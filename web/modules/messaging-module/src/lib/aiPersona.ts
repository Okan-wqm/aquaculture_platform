/**
 * AI persona display names (FAZ 2.4 — AI visibility).
 *
 * `channel.aiPersona` is a persona ID ('expert-farm-production-v1', …), not a
 * display string. Names come from the shared persona catalogue
 * (`@aquaculture/shared-contracts`) — the same SSoT ai-service, messaging-
 * service and aquamobil read, so every surface calls a persona the same thing.
 * Unknown IDs fall back to the raw ID (still better than hiding the persona)
 * and missing personas to the caller's generic 'AI Assistant' label.
 * Display-only — never used for routing or authorization.
 */
import { findAiPersona } from '@aquaculture/shared-contracts';

/**
 * Display name for a channel's AI persona. Empty/null personas return null so
 * the caller falls back to its generic AI label (t('messaging.aiAssistant')).
 */
export function aiPersonaDisplayName(aiPersona: string | null | undefined): string | null {
  if (!aiPersona) return null;
  return findAiPersona(aiPersona)?.name ?? aiPersona;
}
