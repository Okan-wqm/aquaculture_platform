import { describe, expect, it } from 'vitest';

import {
  EDGE_REJECTED_WIDGET_TYPES,
  EDGE_SUPPORTED_WIDGET_TYPES,
  classifyWidgetTypeForEdge,
  type EdgeWidgetClassification,
} from '@platform/sensor-contracts';

import { PALETTE_CATEGORIES } from '../constants/scada-palette-categories';
import type { ScadaWidgetType } from '../types/scada-widget.types';

/**
 * CONTRACT-H-002 — FE↔contract widget-roster invariants.
 *
 * Type-level pins (compile errors, not runtime failures):
 *  - every contract roster member IS a ScadaWidgetType (a rename on either
 *    side breaks the assignment below);
 *  - EXPECTED_CLASSIFICATION is keyed by the FULL ScadaWidgetType union, so
 *    ADDING a widget type to the builder without deciding its edge fate
 *    (ship/strip/reject) refuses to compile. That forced decision is the
 *    whole point: a new CONTROL widget must be consciously added to
 *    EDGE_REJECTED_WIDGET_TYPES, never silently strip-defaulted.
 */

// Type-level: contract rosters ⊆ the builder union.
const shipRoster: readonly ScadaWidgetType[] = EDGE_SUPPORTED_WIDGET_TYPES;
const rejectRoster: readonly ScadaWidgetType[] = EDGE_REJECTED_WIDGET_TYPES;

// Exhaustive partition of the builder union — every member classified.
const EXPECTED_CLASSIFICATION: Record<ScadaWidgetType, EdgeWidgetClassification> = {
  // ship — camelCase mirror of the Rust WidgetType enum
  gauge: 'ship',
  numericDisplay: 'ship',
  statusIndicator: 'ship',
  tankLevel: 'ship',
  trendChart: 'ship',
  alarmBanner: 'ship',
  alarmList: 'ship',
  toggleSwitch: 'ship',
  slider: 'ship',
  numericInput: 'ship',
  pushButton: 'ship',
  emergencyStop: 'ship',
  calibrationWizard: 'ship',
  calibrationHistory: 'ship',
  calibrationStatus: 'ship',
  processView: 'ship',
  // reject — control semantics; silent strip would be unsafe
  equipment: 'reject',
  knob: 'reject',
  dropdownSelect: 'reject',
  scheduler: 'reject',
  vfdDrive: 'reject',
  vfdMini: 'reject',
  vfdGroup: 'reject',
  // strip — decorative
  screenLink: 'strip',
  staticText: 'strip',
  svgRect: 'strip',
  svgCircle: 'strip',
  svgLine: 'strip',
  svgText: 'strip',
  customSvg: 'strip',
  svgEllipse: 'strip',
  svgPath: 'strip',
  svgPolygon: 'strip',
  svgTriangle: 'strip',
  svgDiamond: 'strip',
  svgArrow: 'strip',
  rasterImage: 'strip',
  videoStream: 'strip',
  mapView: 'strip',
  iframe: 'strip',
  fuxaWidget: 'strip',
  // strip — display-only value widgets (no actuation lost on the device)
  pipeFlow: 'strip',
  progressBar: 'strip',
  barChart: 'strip',
  pieChart: 'strip',
  dataTable: 'strip',
  feeder: 'strip',
  radialFilter: 'strip',
  cleanWaterTank: 'strip',
  dirtyWaterTank: 'strip',
  mbbr: 'strip',
  hepaFilter: 'strip',
  cornellDualDrain: 'strip',
};

describe('edge widget support — FE↔contract invariants (CONTRACT-H-002)', () => {
  it('runtime classification matches the pinned partition for EVERY builder widget type', () => {
    const mismatches = (Object.keys(EXPECTED_CLASSIFICATION) as ScadaWidgetType[])
      .map((t) => ({ type: t, expected: EXPECTED_CLASSIFICATION[t], actual: classifyWidgetTypeForEdge(t) }))
      .filter((e) => e.expected !== e.actual);
    expect(mismatches).toEqual([]);
  });

  it('roster sizes stay pinned (16 ship / 7 reject)', () => {
    expect(shipRoster).toHaveLength(16);
    expect(rejectRoster).toHaveLength(7);
  });

  it('every palette entry has a decided edge classification', () => {
    // Palette `type` is already ScadaWidgetType at compile time; this pins
    // the runtime agreement so palette drift shows up as a named diff.
    const undecided = PALETTE_CATEGORIES.flatMap((c) => c.widgets)
      .map((w) => w.type)
      .filter((t) => classifyWidgetTypeForEdge(t) !== EXPECTED_CLASSIFICATION[t]);
    expect(undecided).toEqual([]);
  });
});
