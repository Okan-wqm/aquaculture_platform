/**
 * @aquaculture/shared-contracts — Public API
 *
 * NARROW cross-stack constant library. This barrel hosts ONLY zero-dependency
 * values that must be byte-identical on BOTH the backend trust boundary and the
 * standalone aquamobil Vite/Rollup bundle (which cannot reach into the NestJS
 * lib graph). Today that is exactly two things: the messaging media MIME
 * allowlist and the AI persona id grammar + catalogue (FARM-AI PR-0).
 *
 * Domain ENUMS do NOT live here. @platform/event-contracts is the canonical SSoT
 * for cross-service domain enums (TenantStatus, TenantPlan, PlanTier,
 * BillingCycle, the lifecycle machines, …). This lib's tsconfig is deliberately
 * isolated (no cross-lib paths) so it cannot import event-contracts — which means
 * any enum re-declared here would be a SILENT DUPLICATE that drifts from the
 * canonical. ORPHAN-087 deleted the four dead duplicate enum files
 * (plan-tier / billing / impersonation / data-request — zero importers repo-wide)
 * that previously made this look like an authoritative enum SSoT. The
 * tests/invariants/shared-contracts-no-enum-drift.spec.ts guard keeps it narrow.
 */

// ── Messaging Media MIME Allowlist (MSG-MEDIUM-057) ──
// Single source of truth for the messaging media upload MIME allowlist, shared
// by the server trust boundary (media.service.ts) and the client UX path
// (useMediaUpload.ts / AttachmentPicker.tsx). Zero-dependency by design so it
// can be path-aliased into the standalone aquamobil Vite/Rollup bundle.
export { MESSAGING_MEDIA_MIME_ALLOWLIST } from './enums/messaging-media-mime';
export type { MessagingMediaMime } from './enums/messaging-media-mime';

// ── AI Persona Grammar + Catalogue (FARM-AI PR-0) ──
// Canonical persona id grammar and the frozen persona catalogue, shared by the
// messaging-service channel trust boundary (@IsKnownAiPersonaId), the
// gateway/ws persona gate, and the aquamobil/shell persona pickers. Prompts
// and tool names are backend-owned (ai-service) and deliberately NOT here.
export {
  AI_PERSONA_TIERS,
  AI_SPECIALTY_IDS,
  AI_PERSONA_ID_RE,
  AI_PERSONA_ID_MAX_LENGTH,
  isAiPersonaId,
  parseAiPersonaId,
  formatAiPersonaId,
} from './ai/persona-id';
export type { AiPersonaTier, AiSpecialtyId, ParsedAiPersonaId } from './ai/persona-id';
export {
  AI_SPECIALTY_CATALOGUE,
  AI_PERSONA_TIER_LABELS,
  AI_PERSONA_CATALOGUE,
  DEFAULT_AI_PERSONA_ID,
  AI_GENERAL_ASSISTANT_PICKER_ENTRY,
  findAiPersona,
} from './ai/persona-catalogue';
export type {
  AiSpecialtyDefinition,
  AiPersonaCatalogueEntry,
} from './ai/persona-catalogue';
