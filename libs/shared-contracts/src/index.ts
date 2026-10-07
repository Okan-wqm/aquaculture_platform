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
  findAiPersona,
  DEFAULT_AI_PERSONA_ID,
  AI_GENERAL_ASSISTANT_PICKER_ENTRY,
} from './ai/persona-catalogue';
export type {
  AiPersonaIcon,
  AiPersonaColor,
  AiSpecialtyModule,
  AiSpecialtyDefinition,
  AiPersonaCatalogueEntry,
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
  toCanonicalUnit,
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
