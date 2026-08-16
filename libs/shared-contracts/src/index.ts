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
 * BillingCycle, the lifecycle machines, …). The one deliberate cross-library
 * edge is @platform/identity so signed cross-stack claims consume the canonical
 * platform role authority instead of redeclaring it here. ORPHAN-087 deleted
 * the four dead duplicate enum files
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

export { CSRF_SECURITY_POSTURE } from './http/csrf-security-posture';
export type { CsrfSecurityPosture } from './http/csrf-security-posture';
export {
  DEFAULT_IMPERSONATION_PERMISSIONS,
  IMPERSONATION_BOOLEAN_GRANTS,
  IMPERSONATION_AUTHORIZATION_HTTP_METHODS,
  IMPERSONATION_AUTHORIZATION_OPERATION_LIMIT,
  IMPERSONATION_AUTHORIZATION_RECEIPT_VERSION,
  IMPERSONATION_CREDENTIAL_HEADER,
  IMPERSONATION_CREDENTIAL_PATTERN,
  IMPERSONATION_CONTEXT_ID_PATTERN,
  IMPERSONATION_HANDOFF_FRAGMENT_FIELDS,
  IMPERSONATION_MODULES,
  IMPERSONATION_OPERATION_GRANT_MAP,
  IMPERSONATION_PERMISSION_FIELDS,
  IMPERSONATION_SESSION_HEADER,
  compileImpersonationPermissionsV1,
  compileImpersonationAuthorizationOperationsV1,
  decodeCanonicalImpersonationAuthorizationOperationsV1,
  decodeCanonicalImpersonationPermissionsV1,
  evaluateImpersonationAuthorization,
  isImpersonationCredential,
  isImpersonationAuthorizationHttpMethod,
  isImpersonationContextId,
  isImpersonationModule,
  isImpersonationOperationAuthority,
  isImpersonationPermissionsContract,
  impersonationAuthorizationRequestDigestV1,
  impersonationAuthorizationOperationSetDigestV1,
} from './http/impersonation-policy';
export type {
  ImpersonationAuthorizationHttpMethod,
  ImpersonationAuthorizationReceiptCoordinateV1,
  ImpersonationAuthorizationDecision,
  ImpersonationBooleanGrant,
  ImpersonationModule,
  ImpersonationOperationAuthority,
  ImpersonationOperationDescriptor,
  ImpersonationPermissionsContract,
} from './http/impersonation-policy';
export {
  GATEWAY_VERIFIED_USER_ASSERTION_FIELDS_V1,
  GATEWAY_VERIFIED_USER_ASSERTION_LIMITS_V1,
  compileGatewayVerifiedUserAssertionV1,
  decodeCanonicalGatewayVerifiedUserAssertionV1,
  decodeGatewayVerifiedUserAssertionHeaderV1,
  encodeGatewayVerifiedUserAssertionV1,
} from './http/gateway-verified-user-assertion-v1';
export type {
  DecodeGatewayVerifiedUserAssertionOptionsV1,
  GatewayVerifiedUserAssertionV1,
} from './http/gateway-verified-user-assertion-v1';

export {
  CANONICAL_JSON_LIMITS_V1,
  MOBILE_COMMAND_PAYLOAD_HASH_AUTHORITY_V1,
  canonicalJsonHashPreimageV1,
  canonicalJsonSha256,
  canonicalJsonStringify,
  canonicalWireJsonContentSha256V1,
  canonicalWireJsonSha256V1,
  canonicalWireJsonStringifyV1,
  compareUtf16CodeUnits,
  containsAsciiControlCharacter,
  createCanonicalJsonDocumentV1,
  createWireJsonDocumentV1,
  mobileCommandPayloadSha256V1,
  sha256Hex,
} from './canonical-json';
export {
  ADMIN_CACHE_INVALIDATION_RECEIPT_SCHEMA_VERSION,
  ADMIN_CACHE_INVALIDATION_RECEIPT_HASH_AUTHORITY_V1,
  ADMIN_CACHE_KEY_SET_HASH_AUTHORITY_V1,
  adminCacheKeySetSha256V1,
  adminCacheInvalidationReceiptSha256V1,
  adminCacheInvalidationReceiptHasValidIdentity,
  type AdminCacheInvalidationSelectorV1,
  type AdminCacheInvalidationEvidenceV1,
  type AdminCacheInvalidationReceiptV1,
} from './admin-cache-invalidation';
export {
  ANALYTICS_METRIC_CATALOG_SCHEMA_VERSION,
  ANALYTICS_MEASUREMENT_EVIDENCE_SCHEMA_VERSION,
  ANALYTICS_METRIC_CATALOG_HASH_AUTHORITY_V1,
  ANALYTICS_DASHBOARD_METRIC_CATALOG_V1,
  ANALYTICS_DASHBOARD_METRIC_CATALOG_SHA256,
  analyticsMetricDefinitionsForSectionV1,
  compileAnalyticsMeasurementEvidenceV1,
  assertAnalyticsMetricFieldSetV1,
  createAnalyticsMetricSectionProjectionV1,
  createUnavailableAnalyticsMetricSectionProjectionV1,
  analyticsMetricSectionProjectionHasValidEvidenceV1,
  type AnalyticsMetricSection,
  type AnalyticsMetricQualification,
  type AnalyticsMetricUnavailableReason,
  type AnalyticsMetricDefinitionV1,
  type AnalyticsMeasurementEvidenceV1,
  type AnalyticsMeasurementEvidenceMapV1,
  type AnalyticsMetricSectionValuesV1,
  type AnalyticsMetricSectionProjectionV1,
  type AnalyticsModuleUsageValueV1,
  type AnalyticsTopFeatureValueV1,
} from './analytics-metric-catalog';
export {
  AUDIT_STATISTICS_SCOPE_SCHEMA_VERSION,
  AUDIT_STATISTICS_SCOPE_HASH_AUTHORITY_V2,
  auditStatisticsScopeSha256V2,
  createAuditStatisticsScopeV2,
  auditStatisticsScopeHasValidIdentityV2,
  auditStatisticsProjectionHasValidEvidenceV2,
  type AuditStatisticsScopeEvidenceV2,
  type AuditStatisticsScopeV2,
  type AuditStatisticsProjectionEvidenceV2,
} from './audit-statistics-scope';
export type {
  CanonicalHashAuthorityV1,
  CanonicalJsonDocumentV1,
  CanonicalJsonLimitsV1,
  CanonicalJsonPrimitive,
  CanonicalJsonValue,
} from './canonical-json';
