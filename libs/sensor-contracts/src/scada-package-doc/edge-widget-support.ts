/**
 * @module EdgeWidgetSupport
 *
 * Cloud↔edge widget-type parity roster (CONTRACT-H-002). The browser
 * builder's widget union is ~53 types; the Rust edge runtime
 * (`sens-api-gateway/src/scada_types.rs` `WidgetType`) understands exactly
 * the 16 listed here. This module is the SSoT for what happens to each
 * type at the publish boundary:
 *
 *  - **ship**   — camelCase mirror of the Rust enum; deploys verbatim.
 *  - **reject** — carries CONTROL semantics (writes, schedules, VFD
 *    start/stop). Silently stripping one would change what the operator
 *    can actuate, so its presence BLOCKS the deploy with an actionable,
 *    per-widget error.
 *  - **strip**  — decorative or display-only. Removed from the edge
 *    payload (the stored package keeps it); losing it on the local HMI
 *    costs pixels, not behaviour. Unknown future types default here.
 *
 * Cross-language pins: the deploy fixtures exercise every `ship` type and
 * the Rust parity test asserts none deserializes to `Unknown`; the FE
 * invariant spec pins that this roster exactly partitions the builder's
 * `ScadaWidgetType` union.
 */

/** camelCase mirror of the Rust `WidgetType` enum — deploys verbatim. */
export const EDGE_SUPPORTED_WIDGET_TYPES = [
  // Display
  'gauge',
  'numericDisplay',
  'statusIndicator',
  'tankLevel',
  'trendChart',
  'alarmBanner',
  'alarmList',
  // Control
  'toggleSwitch',
  'slider',
  'numericInput',
  'pushButton',
  'emergencyStop',
  // Calibration
  'calibrationWizard',
  'calibrationHistory',
  'calibrationStatus',
  // Composite
  'processView',
] as const;

export type EdgeSupportedWidgetType = (typeof EDGE_SUPPORTED_WIDGET_TYPES)[number];

/**
 * Control-semantics widget types the edge cannot run: stripping them
 * silently would be UNSAFE (the operator would lose an actuation surface
 * without being told), so they block the deploy instead.
 * `equipment` carries 57 subtypes with start/stop bindings.
 */
export const EDGE_REJECTED_WIDGET_TYPES = [
  'knob',
  'dropdownSelect',
  'scheduler',
  'vfdDrive',
  'vfdMini',
  'vfdGroup',
  'equipment',
] as const;

export type EdgeRejectedWidgetType = (typeof EDGE_REJECTED_WIDGET_TYPES)[number];

/** Closed screen-type set of the Rust `ScreenType` enum (camelCase wire values). */
export const EDGE_SCREEN_TYPES = [
  'dashboard',
  'process',
  'calibration',
  'trends',
  'alarms',
  'control',
] as const;

export type EdgeScreenType = (typeof EDGE_SCREEN_TYPES)[number];

/** Closed severity set of the Rust `AlarmSeverity` enum (camelCase wire values). */
export const EDGE_ALARM_SEVERITIES = ['critical', 'high', 'warning', 'info'] as const;

export type EdgeAlarmSeverity = (typeof EDGE_ALARM_SEVERITIES)[number];

export type EdgeWidgetClassification = 'ship' | 'strip' | 'reject';

const SUPPORTED = new Set<string>(EDGE_SUPPORTED_WIDGET_TYPES);
const REJECTED = new Set<string>(EDGE_REJECTED_WIDGET_TYPES);

/**
 * Classify a widget type for edge deploy. Unknown strings classify as
 * `strip` — a future decorative type must not brick deploys, and a future
 * CONTROL type must be added to {@link EDGE_REJECTED_WIDGET_TYPES}
 * explicitly (the FE invariant spec forces that decision per new type).
 */
export function classifyWidgetTypeForEdge(widgetType: string): EdgeWidgetClassification {
  if (SUPPORTED.has(widgetType)) return 'ship';
  if (REJECTED.has(widgetType)) return 'reject';
  return 'strip';
}
