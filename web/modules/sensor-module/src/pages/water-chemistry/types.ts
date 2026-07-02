/**
 * Water-Chemistry Monitoring — resolve/provenance contract (mock phase).
 *
 * This is the NET-NEW layer over the pure `@platform/aquaculture-engines` engine:
 * a per-scope (tank | loop | site) RESOLVED parameter set with full provenance +
 * staleness. The engine has no scope concept — it is a stateless calculator — so
 * this contract is where the flexibility (cascade + source binding) lives.
 *
 * IMPORTANT: this shape is designed to equal the FUTURE backend contract so the
 * real-phase swap is data-source-only. Every field maps onto a real column:
 *   - resolution axis = sensor.entity denormalized tankId/systemId/siteId
 *   - source/channel  = WaterQualityParamEquipment.sensorId + SensorDataChannel.channelKey
 *   - quality/asOf    = sensor_reading.quality / .timestamp / sensor.lastSeenAt
 * (Promotion of this type to a shared/engine location is a real-phase follow-up.)
 */

/** Scope a chart/readout is projected for. */
export type WcScopeKind = 'site' | 'loop' | 'tank';
export interface WcScope {
  kind: WcScopeKind;
  id: string;
}

/**
 * Parameters we monitor. Engine-consumed (temperature..tan) + DO which the engine
 * does NOT compute but is the most safety-critical, most tank-variable RAS reading.
 */
export type ParamKey =
  | 'temperature'
  | 'salinity'
  | 'ph'
  | 'alkalinity'
  | 'calcium'
  | 'tan'
  | 'nitrate'
  | 'co2'
  | 'h2s'
  | 'dissolvedOxygen';

/** Effective source of a resolved value. `inherit` is NEVER terminal (see resolvedLevel). */
export type ParamSource = 'sensor' | 'manual' | 'derived';

/** Where in the cascade the binding was actually found. */
export type ResolvedLevel = 'tank' | 'loop' | 'site';

/** Derived freshness tier from asOf age + quality (never a bare boolean). */
export type Freshness = 'fresh' | 'stale' | 'offline' | 'bad-quality' | 'n/a';

/** One resolved parameter with full provenance. `value: null` = no data (never fabricated). */
export interface ResolvedValue {
  parameter: ParamKey;
  value: number | null;
  unit: string;
  source: ParamSource;
  /** Tank scope resolving to a loop binding = inherited; resolvedLevel says where it came from. */
  resolvedLevel: ResolvedLevel;
  sensorId?: string;
  channelId?: string;
  /** ISO timestamp of the value (sensor reading time or manual entry time). */
  asOf?: string;
  /** 0..100 reading quality (maps to sensor_reading.quality). */
  quality?: number;
  stale: boolean;
  freshness: Freshness;
}

export interface ResolvedParameterSet {
  scope: WcScope;
  scopeName: string;
  values: ResolvedValue[];
  /**
   * True only when a single SELF-CONSISTENT measurement tuple was available for the
   * engine (one pH+alk+temp+salinity+Ca+TAN set). A loop must NEVER feed the engine a
   * per-parameter worst-case Frankenstein — that flag gates the drill-down chart.
   */
  engineReady: boolean;
}

// ============================================================================
// CARD CANVAS MODEL (P2 redesign)
// ============================================================================

/** Which chart a card renders (switchable via the card header dropdown). */
export type ChartType = 'deffeyes' | 'nh3' | 'h2s' | 'co2';

/** A card's scope is a tank OR a biofilter loop. */
export type CardScopeKind = 'tank' | 'biofilter';
export interface CardScope {
  kind: CardScopeKind;
  id: string;
}

/** Per-parameter source: bound to a sensor channel, or a manual value. */
export interface ParamSourceConfig {
  mode: 'sensor' | 'manual';
  sensorId?: string;
  channelId?: string;
  value?: number;
}

/** Editable toxicity/target limits (seeded from a species template). */
export interface CardLimits {
  tan: number;
  nh3Limit: number;
  co2Toxic: number;
  h2sLimitUgL: number;
  caMgL: number;
  targetPh: number;
  targetAlk: number;
}

/** GridStack geometry. */
export interface CardLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One configurable water-chemistry card = an explicitly-configured measurement point.
 * No cascade inheritance: each card picks its own per-parameter sources.
 */
export interface WcCard {
  id: string;
  title: string;
  scope: CardScope;
  samplingLabel: string;
  speciesTemplateId: string;
  limits: CardLimits;
  volumeM3: number;
  paramSources: Record<ParamKey, ParamSourceConfig>;
  chartType: ChartType;
  layout: CardLayout;
}
