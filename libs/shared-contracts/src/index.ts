/**
 * @aquaculture/shared-contracts — Public API
 *
 * NARROW cross-stack constant library. This barrel hosts ONLY zero-dependency
 * values that must be byte-identical on BOTH the backend trust boundary and the
 * standalone aquamobil Vite/Rollup bundle (which cannot reach into the NestJS
 * lib graph).
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

export {
  CANONICAL_JSON_LIMITS_V1,
  MOBILE_COMMAND_PAYLOAD_HASH_AUTHORITY_V1,
  canonicalJsonHashPreimageV1,
  canonicalJsonSha256,
  canonicalJsonStringify,
  canonicalWireJsonSha256V1,
  canonicalWireJsonStringifyV1,
  compareUtf16CodeUnits,
  createCanonicalJsonDocumentV1,
  createWireJsonDocumentV1,
  mobileCommandPayloadSha256V1,
  sha256Hex,
} from './canonical-json';
export { FARM_DURABLE_MUTATION_AUTHORITY_IDS_V1 } from './farm-durable-mutation-authority';
export type { FarmDurableMutationAuthorityIdV1 } from './farm-durable-mutation-authority';
export {
  MOBILE_COMMAND_ENVELOPE_CONTRACT_V1,
  defineMobileCommandIdentityV1,
} from './mobile-command-envelope';
export type { MobileCommandIdentityV1 } from './mobile-command-envelope';
export type {
  CanonicalHashAuthorityV1,
  CanonicalJsonDocumentV1,
  CanonicalJsonLimitsV1,
  CanonicalJsonPrimitive,
  CanonicalJsonValue,
} from './canonical-json';
