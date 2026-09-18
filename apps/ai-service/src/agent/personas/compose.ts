/**
 * FARM-AI PR-2 — tier × specialty persona composition.
 *
 * A persona is no longer a hand-written singleton: it is COMPOSED from
 *   tier (privilege class) × specialty (domain)
 * against the frozen cross-stack catalogue (AI_PERSONA_CATALOGUE in
 * @aquaculture/shared-contracts — the id/permission SSoT). The shared
 * PREAMBLE joins the fragments; Commit A ships it EMPTY so the composed
 * legacy personas are byte-identical to the pre-PR-2 constants
 * (persona-parity.spec pins that with frozen fixtures).
 *
 * actuationPolicy = min(tier.ceiling, specialty.cap) — a manager-tier farm
 * specialist stays read-only (tier blocks), an expert-tier farm specialist can
 * at most PROPOSE (specialty caps at confirm_required). The AI only suggests;
 * the decision stays with the user.
 */
import {
  AI_PERSONA_CATALOGUE,
  type AiPersonaCatalogueEntry,
  type AiPersonaTier,
  type AiSpecialtyId,
} from '@aquaculture/shared-contracts';
import type { AgentPersona } from '../agent-profile.service';
import type { AgentTier } from './tiers';
import type { AgentSpecialty } from './specialties';

/**
 * Commit B: the shared preamble every persona prompt STARTS with — the
 * program's core principles in instruction form. No fabrication (tool result
 * or say-so), suggestion-not-decision (the human decides), stay in role,
 * answer in the user's language. The tier/specialty fragments then add
 * privilege class and domain on top; persona-parity.spec freezes the joined
 * result for the legacy ids.
 */
export const PROMPT_PREAMBLE = `You are an AI assistant on an aquaculture farm platform.

NON-NEGOTIABLE RULES:
1. Never fabricate data. A number, reading, status or date is either present in a tool result you were given, or you say you do not know it.
2. You suggest; the human decides. Never state that something was changed, created or scheduled unless a tool result confirms it happened. Label proposals clearly as proposals.
3. Stay within your role and your tools. If a request needs data or actions outside them, say so — do not improvise or guess.
4. Always respond in the user's language.`;

/** A composed persona: the AgentPersona contract plus its derivation inputs. */
export interface ComposedPersona extends AgentPersona {
  readonly tier: AiPersonaTier;
  readonly specialty: AiSpecialtyId;
  readonly requiredCapabilities: readonly string[];
}

const ACTUATION_RANK = { blocked: 0, confirm_required: 1, allowed: 2 } as const;
type ActuationPolicy = AgentPersona['actuationPolicy'];

function minActuation(a: ActuationPolicy, b: ActuationPolicy): ActuationPolicy {
  return ACTUATION_RANK[a] <= ACTUATION_RANK[b] ? a : b;
}

/**
 * Compose one persona. `entry` is the catalogue row (id + display metadata +
 * requiredCapabilities); tier/specialty supply behavior. Pure: same inputs →
 * same output object graph, no service lookups.
 */
export function composePersona(
  entry: AiPersonaCatalogueEntry,
  tier: AgentTier,
  specialty: AgentSpecialty,
): ComposedPersona {
  const systemPrompt = [PROMPT_PREAMBLE, tier.promptFragment, specialty.promptFragment]
    .filter((fragment) => fragment.length > 0)
    .join('\n\n');

  return {
    id: entry.id,
    // General personas keep the legacy short tier name (parity-critical: the
    // name feeds the safety middleware's prompt hardening); farm personas use
    // the catalogue display name.
    name: specialty.id === 'general' ? tier.name : entry.name,
    model: tier.model,
    systemPrompt,
    // Order preserved from the specialty bundle; the tier gates ACCESS.
    defaultToolNames: specialty.toolNames.filter((tool) => tier.tierAllowsTool(tool)),
    actuationPolicy: minActuation(tier.actuationCeiling, specialty.actuationCap),
    maxTokensPerTurn: tier.maxTokensPerTurn,
    // Tool ceiling: tiers are the platform's own privilege classes — tenants
    // may expand them. (Service-grant personas override this to false.)
    allowAdditionalTools: true,
    permissionModel: 'user-tier',
    tier: tier.id,
    specialty: specialty.id,
    requiredCapabilities: entry.requiredCapabilities,
  };
}

/** Compose every catalogue entry from the supplied tiers/specialties. */
export function composeCatalogue(
  tiers: Record<AiPersonaTier, AgentTier>,
  specialties: Record<AiSpecialtyId, AgentSpecialty>,
): ReadonlyMap<string, ComposedPersona> {
  const map = new Map<string, ComposedPersona>();
  for (const entry of AI_PERSONA_CATALOGUE) {
    map.set(entry.id, composePersona(entry, tiers[entry.tier], specialties[entry.specialty]));
  }
  return map;
}
