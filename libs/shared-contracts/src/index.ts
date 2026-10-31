/**
 * @aquaculture/shared-contracts — Public API
 *
 * NARROW cross-stack constant library. This barrel hosts ONLY zero-dependency
 * values that must be byte-identical on BOTH the backend trust boundary and the
 * standalone aquamobil Vite/Rollup bundle (which cannot reach into the NestJS
 * lib graph). Today that is: the messaging media MIME allowlist, the AI persona
 * id grammar + catalogue, the design tokens, and the sensor-reading tier policy
 * + time range.
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

// ── Design colour tokens (FE-MEDIUM-093) ──
// The palette `web/shared-ui/src/styles/theme.css` declares, mirrored once for
// both stacks: the browser reads it through `theme.ts`, the HTML e-mail
// builders read it directly, so a customer's first sight of the product is
// painted in the product's colours rather than each service's private hex list.
export {
  colors,
  chartPalette,
  chartChrome,
  colorTokenEntries,
  domainScale,
  sequentialColor,
} from './design/color-tokens';
export type { ColorTokens } from './design/color-tokens';

// The product's severity ladder and the colour each step is painted with.
export { SEVERITY_TONE, severityColor } from './design/severity';
export type { SeverityLevel } from './design/severity';

// The one HTML e-mail layout every service renders through (FE-MEDIUM-093).
export {
  renderEmail,
  emailRows,
  emailButton,
  emailCallout,
  emailSection,
  emailBadge,
  emailParagraph,
  emailLinkFallback,
  emailPlainText,
  emailToneColor,
  escapeHtml,
  safeHref,
} from './design/email-layout';
export type {
  EmailDocument,
  EmailRow,
  EmailTone,
  EmailToneByVariable,
} from './design/email-layout';

// ── Messaging Media MIME Allowlist (MSG-MEDIUM-057) ──
// Single source of truth for the messaging media upload MIME allowlist, shared
// by the server trust boundary (media.service.ts) and the client UX path
// (useMediaUpload.ts / AttachmentPicker.tsx). Zero-dependency by design so it
// can be path-aliased into the standalone aquamobil Vite/Rollup bundle.
export { MESSAGING_MEDIA_MIME_ALLOWLIST } from './enums/messaging-media-mime';
export type { MessagingMediaMime } from './enums/messaging-media-mime';

// ── Module dictionary (RBAC-MEDIUM-023) ──
// The one declaration of the platform's module codes: every tenant module, the
// owner modules (farm, hr, sensor, hydroponics; hydroponics reserved) and the
// guards for codes crossing a trust boundary. Token grants, registry keys,
// department and alarm modules, Postgres labels and GraphQL enums derive from it.
export {
  PLATFORM_MODULE,
  PLATFORM_MODULE_CODES,
  MODULE_DESCRIPTORS,
  OWNER_MODULE,
  OWNER_MODULE_CODES,
  ACTIVE_OWNER_MODULE_CODES,
  isPlatformModuleCode,
  isOwnerModuleCode,
  isActiveOwnerModuleCode,
} from './modules/platform-modules';
export type {
  PlatformModuleKey,
  PlatformModuleCode,
  ModuleLifecycle,
  ModuleDescriptor,
  OwnerModuleCode,
  ActiveOwnerModuleCode,
} from './modules/platform-modules';

// ── Access vocabulary (RBAC-MEDIUM-024; ADR-051 §1) ──
// The platform roles and their one hierarchy, the tenant capability catalogue and the one
// capability check, the access kinds, the member and service callers, ModuleScope, and the one
// pure decideAccess that guards, NATS responders, sockets, notification fan-out and the nav call.
export {
  PLATFORM_ROLES_BY_PRIVILEGE,
  PLATFORM_ROLE,
  PLATFORM_ROLE_KIND,
  PLATFORM_ROLE_HIERARCHY,
  ACCOUNT_ROLES,
  MODULE_ROLES,
  isPlatformRole,
  isAccountRole,
  isModuleRole,
  platformRoleSatisfies,
  highestPlatformRole,
  accountRoleOf,
} from './access/platform-roles';
export type {
  PlatformRole,
  PlatformRoleKind,
  AccountRole,
  ModuleRole,
} from './access/platform-roles';
export {
  TENANT_CAPABILITY_CATALOGUE,
  TENANT_CAPABILITIES,
  COMPANY_VIEW_CAPABILITY,
  EDGE_DEVICE_IO_CONFIG_CAPABILITY,
  isTenantCapability,
  holdsTenantCapabilities,
} from './access/tenant-capabilities';
export type {
  TenantCapability,
  TenantCapabilityCatalogue,
  TenantCapabilityCategoryKey,
  TenantCapabilityHolder,
  TenantCapabilityPanel,
} from './access/tenant-capabilities';
export {
  ALL_MODULES_SCOPE,
  ScopeWideningError,
  moduleScopeOf,
  moduleScopeIncludes,
  narrowModuleScope,
} from './access/module-scope';
export type { ModuleScope, NonEmptyReadonlyArray } from './access/module-scope';
export { NATS_SERVICE_NAMES, serviceCaller } from './access/access-spec';
export { MalformedCallerError, isModuleAccess, userCaller } from './access/user-caller';
export type {
  CallerClaim,
  ModuleAccess,
  UserCaller,
  VerifiedMemberIdentity,
} from './access/user-caller';
export type {
  AccessIntent,
  ServiceIntent,
  ScopedKind,
  ModuleAccessSpec,
  ScopedAccessSpec,
  CompanyAccessSpec,
  SelfAccessSpec,
  AccountAccessSpec,
  ServiceAccessSpec,
  MemberAccessSpec,
  AccessSpec,
  AccessKind,
  AccessRequest,
  NatsServiceName,
  ServiceCaller,
  Caller,
  UserSubjectAccess,
  ServiceSubjectAccess,
  SubjectAccess,
} from './access/access-spec';
export { decideAccess, deriveServiceGrants } from './access/decide-access';
export type { AccessDecision, AccessDenyReason, ServiceGrants } from './access/decide-access';

// ── AI Persona Grammar + Catalogue ──
// Single source of truth for persona ids (`<tier>[-<specialty>]-v<N>`) and the
// published persona catalogue (names, icons, RBAC requirements). Consumed by
// ai-service (composition + boot invariants), messaging-service (picker,
// channel validation), gateway-api (socket validation) and the web/mobile
// pickers — replacing four hand-maintained copies. Zero-dependency.
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
  AI_PERSONA_ICONS,
  AI_PERSONA_COLORS,
  AI_ASSISTANT_USE_CAPABILITY,
  aiPersonaTierCapability,
  aiSpecialtyCapability,
  AI_TIER_PRESENTATION,
  AI_SPECIALTY_CATALOGUE,
  AI_PERSONA_CATALOGUE,
  AI_SPECIALTY_MODULE_CODES,
  findAiPersona,
  DEFAULT_AI_PERSONA_ID,
  AI_GENERAL_ASSISTANT_PICKER_ENTRY,
} from './ai/persona-catalogue';
export type {
  AiPersonaIcon,
  AiPersonaColor,
  AiSpecialtyDefinition,
  AiPersonaCatalogueEntry,
  AiPersonaCapability,
} from './ai/persona-catalogue';

// ── Sensor-reading tier policy (SENSOR-MEDIUM-149) ──
// How far back a reading may be asked for, which store answers it at what
// width, and how long each store keeps it — read by the series queries, the
// rollup DDL and the browser's range picker alike.
export {
  AGGREGATION_INTERVALS,
  AGGREGATION_INTERVAL_SQL,
  MAX_SERIES_RANGE_MS,
  SERIES_QUERY_TIMEOUT,
  AS_OF_LOOKBACK,
  DISPLAY_INTERVAL_LADDER,
  displayIntervalFor,
  METRIC_TIERS,
  metricTier,
  tierForWindow,
  MAX_POINTS_PER_CHANNEL,
  planSeriesRead,
} from './sensor-readings/tier-policy';
export type {
  PolicyDuration,
  AggregationIntervalSql,
  MetricTierName,
  MetricTier,
  SeriesReadPlan,
  SeriesBucketZone,
} from './sensor-readings/tier-policy';

// ── Sensor-reading time range ──
// Every preset duration any chart offers, the relative/absolute range shape,
// its check against the tier policy's cap, and its URL form.
export {
  RELATIVE_TIME_RANGE_PRESETS,
  presetDurationMs,
  parsePresetKey,
  SCADA_RANGE_TOKENS,
  scadaRangePreset,
  scadaRangeDurationMs,
  MAX_TIME_RANGE_MS,
  resolveTimeRange,
  parseTimeRangeParams,
  timeRangeToParams,
} from './sensor-readings/time-range';
export type {
  RelativePresetKey,
  ScadaRangeToken,
  TimeRangeSpec,
  TimeRangeError,
  ResolvedTimeRange,
  TimeRangeParams,
  ParsedTimeRange,
} from './sensor-readings/time-range';

// ── Measured quantities ──
// What a sensor channel measures, in which unit and on which basis, and which
// device spellings name it — the vocabulary the reading event, the sensor
// catalog and the farm water-quality templates derive from.
export {
  MEASURED_QUANTITIES,
  QUANTITY_FAMILIES,
  CHANNEL_KEYS,
  measuredQuantity,
  parseQuantityId,
  channelKeyMeaning,
  channelKeyUnit,
  declarableQuantities,
  effectiveQuantity,
  readingParameterOfChannelKey,
  isAcceptedUnit,
  isLoopHomogeneous,
  toCanonicalUnit,
  fromCanonicalUnit,
  convertUnit,
  unitConversion,
} from './measurement/quantities';
export type {
  QuantityId,
  MeasuredQuantity,
  QuantityFamily,
  ReadingParameter,
  ChannelKeyMeaning,
  KnownChannelKey,
  UnitConversion,
} from './measurement/quantities';

// ── Channel binding ──
// Whether a sensor channel can feed a water-chemistry parameter, and the
// reason codes the binding UI shows when it cannot.
export {
  CHANNEL_BINDING_PROBLEM,
  CHANNEL_BINDING_PROBLEMS,
  PARAMETER_SOURCE_ERROR,
  channelProblems,
  parameterProblems,
} from './measurement/channel-binding';
export type {
  ChannelBindingProblem,
  ParameterSourceErrorCode,
  BindableParameter,
  DescribedChannel,
} from './measurement/channel-binding';

// ── Sensor placement ──
// The codes of sensor-service's placement refusals, for the UI's own words.
export { SENSOR_PLACEMENT_ERROR, isSensorPlacementErrorCode } from './measurement/sensor-placement';
export type { SensorPlacementErrorCode } from './measurement/sensor-placement';
export {
  SENSOR_MQTT_IDENTITY_ERROR,
  isSensorMqttIdentityErrorCode,
} from './measurement/sensor-mqtt-identity';
export type { SensorMqttIdentityErrorCode } from './measurement/sensor-mqtt-identity';

// ── Many-unit reads ──
// The most units one many-unit farm read takes; clients batch by it.
export { MAX_UNITS_PER_READ } from './measurement/unit-reads';
