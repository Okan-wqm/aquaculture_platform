/**
 * AI persona id grammar — single source of truth.
 *
 * A persona id is ONE string on every wire and storage seam (`request.ai.chat`
 * payload, gateway `ai:chat` body, `channels.aiPersona`,
 * `agent_conversations.persona`, `ai_proposed_actions.persona`,
 * `tool_execution_audit.persona`, `conversation_turns.personaId` — all
 * varchar(50)). Before this module, four independent hard-coded persona lists
 * and two different validation regexes (gateway `^(operator|…)-v\d+$`,
 * messaging `^[a-z][a-z0-9-]*-v\d+$`) each re-derived the authority tier from
 * the id prefix by hand. This module owns the grammar so every trust boundary
 * validates the same way and the tier can never be mis-derived.
 *
 * Grammar:
 *   `<tier>-v<N>`               — the GENERAL specialty (legacy spelling; the
 *                                 four pre-existing ids keep resolving as-is)
 *   `<tier>-<specialty>-v<N>`   — a topic specialist (e.g. `expert-farm-production-v1`)
 *
 * `general` is spelled ONLY by omission: `expert-general-v1` is rejected so
 * that every persona has exactly one canonical string.
 *
 * Zero-dependency by design (see index.ts): this module is path-aliased into
 * the standalone aquamobil Vite bundle and the shell/microfrontend bundles as
 * well as the NestJS services.
 */

/** Authority tiers, ordered by increasing capability. */
export const AI_PERSONA_TIERS = Object.freeze([
  'operator',
  'manager',
  'expert',
  'supervisor',
] as const);
export type AiPersonaTier = (typeof AI_PERSONA_TIERS)[number];

/**
 * Known specialties. `general` is the topic-agnostic assistant every tier has
 * always offered; the `farm-*` entries are the farm-module experts.
 */
export const AI_SPECIALTY_IDS = Object.freeze([
  'general',
  'farm-water-health',
  'farm-production',
  'farm-operations',
] as const);
export type AiSpecialtyId = (typeof AI_SPECIALTY_IDS)[number];

/**
 * Grammar-only pattern: `<tier>[-<specialty>]-v<N>`. The specialty segment is
 * lowercase words joined by single hyphens; the fixed tier prefix and the
 * fixed `-v<N>` suffix make the parse unambiguous.
 */
export const AI_PERSONA_ID_RE =
  /^(operator|manager|expert|supervisor)(?:-([a-z]+(?:-[a-z]+)*))?-v([1-9]\d*)$/;

/** Column width shared by every persisted persona column. */
export const AI_PERSONA_ID_MAX_LENGTH = 50;

export interface ParsedAiPersonaId {
  readonly tier: AiPersonaTier;
  readonly specialty: AiSpecialtyId;
  readonly version: number;
}

function isTier(value: string): value is AiPersonaTier {
  return (AI_PERSONA_TIERS as readonly string[]).includes(value);
}

function isSpecialty(value: string): value is AiSpecialtyId {
  return (AI_SPECIALTY_IDS as readonly string[]).includes(value);
}

/**
 * Grammar check for trust-boundary validators (gateway body, messaging DTO).
 * Accepts any well-formed id, including specialties this build does not know —
 * the catalogue lookup (`findAiPersona`) decides whether the persona exists.
 */
export function isAiPersonaId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= AI_PERSONA_ID_MAX_LENGTH &&
    AI_PERSONA_ID_RE.test(value)
  );
}

/**
 * Parse an id into tier / specialty / version. Returns `null` when the string
 * is malformed, names an unknown specialty, or spells `general` explicitly.
 */
export function parseAiPersonaId(id: string): ParsedAiPersonaId | null {
  if (!isAiPersonaId(id)) return null;
  const match = AI_PERSONA_ID_RE.exec(id);
  if (!match) return null;
  const tier = match[1];
  const specialtySegment = match[2];
  const versionSegment = match[3];
  if (tier === undefined || versionSegment === undefined || !isTier(tier)) return null;
  if (specialtySegment === 'general') return null;
  const specialty = specialtySegment ?? 'general';
  if (!isSpecialty(specialty)) return null;
  // The grammar admits only `v[1-9]\d*`, so the version is ≥ 1 and spelled
  // canonically (no leading zeros): every parsed id round-trips byte-for-byte.
  const version = Number.parseInt(versionSegment, 10);
  if (!Number.isSafeInteger(version)) return null;
  return { tier, specialty, version };
}

/** Inverse of `parseAiPersonaId`; `general` is spelled by omission. */
export function formatAiPersonaId(parsed: ParsedAiPersonaId): string {
  const specialty = parsed.specialty === 'general' ? '' : `-${parsed.specialty}`;
  return `${parsed.tier}${specialty}-v${parsed.version}`;
}
