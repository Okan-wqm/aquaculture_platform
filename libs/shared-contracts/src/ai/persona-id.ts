/**
 * AI persona id grammar — FARM-AI PR-0 (Sprint 1.1).
 *
 * Canonical persona id form: `<tier>[-<specialty>]-v<version>`
 *   - tier:      operator | manager | expert | supervisor
 *   - specialty: a known specialty id (see AI_SPECIALTY_IDS) — or ABSENT for
 *                the `general` specialty. `general` is written by absence so
 *                every persona has exactly ONE canonical string (the legacy
 *                ids `operator-v1` / `manager-v1` / `expert-v1` /
 *                `supervisor-v1` parse as tier × general v1 and stay valid).
 *
 * ZERO imports by design: this lib's tsconfig is deliberately isolated (no
 * cross-lib paths) so it can be path-aliased into BOTH the backend trust
 * boundary and the standalone aquamobil Vite/Rollup bundle. Values are
 * `as const` — never `enum` (ORPHAN-087 invariant).
 */

export const AI_PERSONA_TIERS = ['operator', 'manager', 'expert', 'supervisor'] as const;
export type AiPersonaTier = (typeof AI_PERSONA_TIERS)[number];

export const AI_SPECIALTY_IDS = [
  'general',
  'farm-water-health',
  'farm-production',
  'farm-operations',
] as const;
export type AiSpecialtyId = (typeof AI_SPECIALTY_IDS)[number];

/**
 * Grammar-only shape of a persona id. The tier alternation is part of the
 * grammar (an unknown tier is malformed, not merely unknown); the specialty
 * segment accepts ANY lowercase-hyphen token so the regex stays a pure
 * SYNTAX gate — catalogue membership is a separate, stricter check
 * (`findAiPersona` in persona-catalogue.ts).
 */
export const AI_PERSONA_ID_RE =
  /^(operator|manager|expert|supervisor)(?:-([a-z]+(?:-[a-z]+)*))?-v(\d+)$/;

export const AI_PERSONA_ID_MAX_LENGTH = 50;

export interface ParsedAiPersonaId {
  tier: AiPersonaTier;
  specialty: AiSpecialtyId;
  version: number;
}

const KNOWN_TIERS: ReadonlySet<string> = new Set(AI_PERSONA_TIERS);
const KNOWN_SPECIALTIES: ReadonlySet<string> = new Set(AI_SPECIALTY_IDS);

/**
 * Trust-boundary gate: is `v` a syntactically valid persona id string?
 * Grammar + length ONLY — it does not check that the specialty is known.
 * Gatekeepers that must reject unknown personas use `findAiPersona` instead.
 */
export function isAiPersonaId(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length <= AI_PERSONA_ID_MAX_LENGTH &&
    AI_PERSONA_ID_RE.test(v)
  );
}

/**
 * Parse a persona id into its parts, or null when the id is malformed or
 * references an unknown tier/specialty. `expert-general-v1` is REJECTED:
 * `general` is expressed by absence, so a persona has one canonical string
 * only (round-trip parse∘format is the identity on accepted inputs).
 */
export function parseAiPersonaId(id: string): ParsedAiPersonaId | null {
  if (typeof id !== 'string' || id.length > AI_PERSONA_ID_MAX_LENGTH) {
    return null;
  }
  const m = AI_PERSONA_ID_RE.exec(id);
  if (!m || m[1] === undefined || m[3] === undefined) {
    return null;
  }
  const tier = m[1];
  const rawSpecialty = m[2] ?? 'general';
  const version = Number(m[3]);
  // Canonical-form rule: `general` is written by ABSENCE. `expert-general-v1`
  // is rejected so parse∘format is the identity (one string per persona).
  if (rawSpecialty === 'general' && m[2] !== undefined) {
    return null;
  }
  if (!KNOWN_TIERS.has(tier) || !KNOWN_SPECIALTIES.has(rawSpecialty)) {
    return null;
  }
  return {
    tier: tier as AiPersonaTier,
    specialty: rawSpecialty as AiSpecialtyId,
    version,
  };
}

/**
 * Inverse of `parseAiPersonaId` — formats by the canonical rule (general
 * written by absence). `formatAiPersonaId(parseAiPersonaId(id)) === id` for
 * every accepted id.
 */
export function formatAiPersonaId(p: ParsedAiPersonaId): string {
  const specialtyPart = p.specialty === 'general' ? '' : `-${p.specialty}`;
  return `${p.tier}${specialtyPart}-v${p.version}`;
}
