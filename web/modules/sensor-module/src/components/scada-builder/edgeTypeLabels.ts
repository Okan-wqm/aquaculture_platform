/**
 * Single source of truth for SCADA edge geometry-type labels.
 *
 * EdgeToolbar (90° / Poly / Curve) and PropertiesPanel (Orthogonal /
 * Polyline / Bezier) previously maintained separate label sets for the
 * same three `ScadaEdgeType` values. Both now read from here so the
 * toolbar and the property sheet can never disagree.
 */

import type { ScadaEdgeType } from '../../types/scada-edge.types';

export interface EdgeTypeOption {
  type: ScadaEdgeType;
  /** Canonical label (property sheet). */
  label: string;
  /** Compact toolbar label. */
  shortLabel: string;
}

export const EDGE_TYPE_OPTIONS: EdgeTypeOption[] = [
  { type: 'orthogonal', label: 'Orthogonal', shortLabel: '90°' },
  { type: 'multiHandle', label: 'Polyline', shortLabel: 'Poly' },
  { type: 'draggable', label: 'Bezier', shortLabel: 'Curve' },
];

export const EDGE_TYPE_LABELS: Record<ScadaEdgeType, string> = Object.fromEntries(
  EDGE_TYPE_OPTIONS.map((o) => [o.type, o.label]),
) as Record<ScadaEdgeType, string>;
