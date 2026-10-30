/**
 * AI persona identity — what an agent looks like (icon, hue) and the job written under it.
 *
 * `channel.aiPersona` is a persona ID ('expert-farm-production-v1', …), not a display string.
 * WHICH personas exist, and their icon and hue, come from the shared catalogue
 * (`@aquaculture/shared-contracts`) — the same SSoT ai-service, messaging-service and aquamobil
 * read. The catalogue's names, descriptions and capabilities are English-only, so the WORDS are
 * localised here by catalogue id: the role key follows the specialty (a general persona's role
 * follows its tier), and the key unions below are typed against the catalogue's id unions, so a
 * new tier or specialty without locale keys is a compile error. Display-only — never used for
 * routing or authorization.
 */
import {
  AI_GENERAL_ASSISTANT_PICKER_ENTRY,
  AI_PERSONA_CATALOGUE,
  AI_PERSONA_ID_RE,
  findAiPersona,
  parseAiPersonaId,
  type AiPersonaCatalogueEntry,
  type AiPersonaColor,
  type AiPersonaIcon,
  type AiPersonaTier,
  type AiSpecialtyId,
} from '@aquaculture/shared-contracts';
import type { MessageKey } from '@aquaculture/shared-ui';

import { capabilityLabel } from './personaCapabilities';

/** The translate function `useI18n()` returns (vars unused by persona copy). */
export type Translate = (key: MessageKey) => string;

type FarmSpecialtyId = Exclude<AiSpecialtyId, 'general'>;
/** A general persona is named by its tier, a specialist by its specialty. */
type RoleSubject = AiPersonaTier | FarmSpecialtyId;

const tierKey = (tier: AiPersonaTier): MessageKey => `messaging.persona.tier.${tier}`;
const roleKey = (subject: RoleSubject): MessageKey => `messaging.persona.role.${subject}`;
const descriptionKey = (subject: RoleSubject): MessageKey => `messaging.persona.desc.${subject}`;

export interface AiPersonaIdentity {
  readonly icon: AiPersonaIcon;
  readonly hue: AiPersonaColor;
  /** null for the tenant default (the tier is the tenant's choice) and unknown ids. */
  readonly tier: AiPersonaTier | null;
  readonly specialty: AiSpecialtyId;
  /** Catalogue capability strings (English SSoT); localizeAiPersona translates them. */
  readonly capabilities: readonly string[];
  /** A topic specialist rather than a general assistant — unknown specialties included. */
  readonly specialist: boolean;
  /** false for an id the panel cannot resolve (kept visible, never hidden). */
  readonly known: boolean;
}

const DEFAULT_IDENTITY: AiPersonaIdentity = Object.freeze({
  icon: AI_GENERAL_ASSISTANT_PICKER_ENTRY.icon,
  hue: AI_GENERAL_ASSISTANT_PICKER_ENTRY.color,
  tier: null,
  specialty: 'general',
  capabilities: AI_GENERAL_ASSISTANT_PICKER_ENTRY.capabilities,
  specialist: false,
  known: true,
});

/**
 * The catalogue entry an id stands for: the exact id, or — for another version of a published
 * tier × specialty (a catalogue version bump, or a server deployed ahead of the panel) — that
 * role's entry, so existing rooms keep their face and translated job across a bump.
 */
function catalogueEntryFor(aiPersona: string): AiPersonaCatalogueEntry | undefined {
  const exact = findAiPersona(aiPersona);
  if (exact) return exact;
  const parsed = parseAiPersonaId(aiPersona);
  if (!parsed) return undefined;
  return AI_PERSONA_CATALOGUE.find(
    (entry) => entry.tier === parsed.tier && entry.specialty === parsed.specialty,
  );
}

/**
 * Icon, hue, tier and specialty of a channel's persona. A missing persona is the tenant
 * default (answered by the general assistant); an id the panel cannot resolve keeps the
 * general look, and counts as a specialist when its id names a specialty segment.
 */
export function aiPersonaIdentity(aiPersona: string | null | undefined): AiPersonaIdentity {
  if (!aiPersona) return DEFAULT_IDENTITY;
  const entry = catalogueEntryFor(aiPersona);
  if (!entry) {
    return {
      ...DEFAULT_IDENTITY,
      capabilities: [],
      specialist: AI_PERSONA_ID_RE.exec(aiPersona)?.[2] !== undefined,
      known: false,
    };
  }
  return {
    icon: entry.icon,
    hue: entry.color,
    tier: entry.tier,
    specialty: entry.specialty,
    capabilities: entry.capabilities,
    specialist: entry.specialty !== 'general',
    known: true,
  };
}

export interface LocalizedAiPersona {
  /** The job, e.g. "Production Specialist" — written under the avatar. */
  readonly role: string;
  /** Authority tier chip ("Expert"); null when the persona has no fixed tier. */
  readonly tierLabel: string | null;
  /** One line on what the agent does; empty for an unknown persona. */
  readonly description: string;
  readonly capabilities: readonly string[];
}

/**
 * The persona's role, tier, description and capabilities in the caller's language. For an id
 * the panel cannot resolve, the role is `fallbackName` (the room's stored name, the server's
 * persona name) and only then the raw id — the persona is never hidden.
 */
export function localizeAiPersona(
  aiPersona: string | null | undefined,
  t: Translate,
  fallbackName?: string | null,
): LocalizedAiPersona {
  const identity = aiPersonaIdentity(aiPersona);
  if (!identity.known) {
    return {
      role: fallbackName || aiPersona || '',
      tierLabel: null,
      description: '',
      capabilities: [],
    };
  }
  const capabilities = identity.capabilities.map((capability) => capabilityLabel(capability, t));
  if (identity.tier === null) {
    return {
      role: t('messaging.aiAssistant'),
      tierLabel: null,
      description: t('messaging.persona.desc.default'),
      capabilities,
    };
  }
  const subject: RoleSubject =
    identity.specialty === 'general' ? identity.tier : identity.specialty;
  return {
    role: t(roleKey(subject)),
    tierLabel: t(tierKey(identity.tier)),
    description: t(descriptionKey(subject)),
    capabilities,
  };
}
