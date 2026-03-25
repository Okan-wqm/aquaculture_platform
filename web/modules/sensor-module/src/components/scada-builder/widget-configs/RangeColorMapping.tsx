/**
 * Universal range-to-color mapping editor for binding tag value ranges
 * to visual properties. Used by any widget that needs value-driven
 * color changes (gauge zones, status indicators, equipment states).
 *
 * Architecture: Stores ranges as an array of {min, max, fill, stroke, label}
 * in the widget's config. The AnimationEngine's colorRange rule type
 * consumes these ranges at runtime.
 *
 * This component replaces widget-specific range implementations (e.g.,
 * GaugeConfig zones) with a shared, reusable pattern.
 */

import React, { useCallback, useMemo } from 'react';
import { Plus, Trash2, AlertTriangle } from 'lucide-react';
import type { ColorRange } from '../../../engine/animation/types';

export type { ColorRange } from '../../../engine/animation/types';

interface RangeColorMappingProps {
  /** Current ranges array from widget config */
  ranges: ColorRange[];
  /** Callback to update ranges in widget config */
  onChange: (ranges: ColorRange[]) => void;
  /** Whether to show stroke color in addition to fill */
  showStroke?: boolean;
  /** Whether to show label text per range */
  showLabel?: boolean;
  /** Maximum number of ranges allowed */
  maxRanges?: number;
}

/** Default fill color for newly created ranges */
const DEFAULT_FILL = '#22c55e';
const DEFAULT_STROKE = '#16a34a';

/**
 * Detects overlapping ranges. Two ranges overlap when one starts before
 * the other ends and vice versa (open-interval overlap check).
 */
function findOverlaps(ranges: ColorRange[]): Set<number> {
  const overlapping = new Set<number>();
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      if (ranges[i].min < ranges[j].max && ranges[j].min < ranges[i].max) {
        overlapping.add(i);
        overlapping.add(j);
      }
    }
  }
  return overlapping;
}

/**
 * Detects ranges where min >= max (invalid configuration).
 */
function findInvalidMinMax(ranges: ColorRange[]): Set<number> {
  const invalid = new Set<number>();
  for (let i = 0; i < ranges.length; i++) {
    if (ranges[i].min >= ranges[i].max) {
      invalid.add(i);
    }
  }
  return invalid;
}

export const RangeColorMapping: React.FC<RangeColorMappingProps> = ({
  ranges,
  onChange,
  showStroke = false,
  showLabel = false,
  maxRanges = 10,
}) => {
  const overlaps = useMemo(() => findOverlaps(ranges), [ranges]);
  const invalidMinMax = useMemo(() => findInvalidMinMax(ranges), [ranges]);
  const hasErrors = overlaps.size > 0 || invalidMinMax.size > 0;

  const addRange = useCallback(() => {
    if (ranges.length >= maxRanges) return;
    const newRange: ColorRange = {
      min: 0,
      max: 100,
      fill: DEFAULT_FILL,
      ...(showStroke ? { stroke: DEFAULT_STROKE } : {}),
      ...(showLabel ? { label: '' } : {}),
    };
    // Auto-sort after adding
    const next = [...ranges, newRange].sort((a, b) => a.min - b.min);
    onChange(next);
  }, [ranges, onChange, maxRanges, showStroke, showLabel]);

  const removeRange = useCallback(
    (index: number) => {
      onChange(ranges.filter((_, i) => i !== index));
    },
    [ranges, onChange],
  );

  const updateRange = useCallback(
    (index: number, field: keyof ColorRange, value: string | number) => {
      const updated = ranges.map((r, i) =>
        i === index ? { ...r, [field]: value } : r,
      );
      // Re-sort by min value whenever min changes to maintain visual order
      if (field === 'min') {
        updated.sort((a, b) => a.min - b.min);
      }
      onChange(updated);
    },
    [ranges, onChange],
  );

  return (
    <div className="space-y-2" data-testid="range-color-mapping">
      <div className="flex items-center justify-between">
        <label className="text-xs text-gray-500 font-medium">Color Ranges</label>
        <button
          type="button"
          onClick={addRange}
          disabled={ranges.length >= maxRanges}
          className={`flex items-center gap-1 text-xs transition-colors ${
            ranges.length >= maxRanges
              ? 'text-gray-400 cursor-not-allowed'
              : 'text-cyan-600 hover:text-cyan-700'
          }`}
          data-testid="add-range-btn"
        >
          <Plus className="w-3 h-3" />
          Add Range
        </button>
      </div>

      {/* Validation summary banner */}
      {hasErrors && (
        <div className="flex items-start gap-1.5 px-2 py-1.5 bg-amber-50 border border-amber-200 rounded text-[10px] text-amber-700">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>
            {overlaps.size > 0 && 'Overlapping ranges detected. '}
            {invalidMinMax.size > 0 && 'Min must be less than Max.'}
          </span>
        </div>
      )}

      {ranges.length === 0 && (
        <p className="text-xs text-gray-500 py-3 text-center">No color ranges defined.</p>
      )}

      {ranges.map((range, idx) => {
        const isOverlap = overlaps.has(idx);
        const isInvalid = invalidMinMax.has(idx);
        const rowError = isOverlap || isInvalid;

        return (
          <div
            key={idx}
            data-testid="range-row"
            className={`flex items-center gap-1 p-1.5 rounded transition-colors ${
              rowError ? 'bg-red-50 border border-red-200' : 'bg-transparent'
            }`}
          >
            {/* Min */}
            <input
              type="number"
              value={range.min}
              onChange={(e) => updateRange(idx, 'min', Number(e.target.value))}
              className={`w-14 px-2 py-1 text-xs border rounded ${
                isInvalid ? 'border-red-400' : 'border-gray-300'
              }`}
              placeholder="Min"
              aria-label="Range minimum"
            />
            {/* Max */}
            <input
              type="number"
              value={range.max}
              onChange={(e) => updateRange(idx, 'max', Number(e.target.value))}
              className={`w-14 px-2 py-1 text-xs border rounded ${
                isInvalid ? 'border-red-400' : 'border-gray-300'
              }`}
              placeholder="Max"
              aria-label="Range maximum"
            />
            {/* Fill color */}
            <input
              type="color"
              value={range.fill}
              onChange={(e) => updateRange(idx, 'fill', e.target.value)}
              className="w-8 h-7 border border-gray-300 rounded cursor-pointer"
              title="Fill color"
              aria-label="Fill color"
            />
            {/* Stroke color (optional) */}
            {showStroke && (
              <input
                type="color"
                value={range.stroke || DEFAULT_STROKE}
                onChange={(e) => updateRange(idx, 'stroke', e.target.value)}
                className="w-8 h-7 border border-gray-300 rounded cursor-pointer"
                title="Stroke color"
                aria-label="Stroke color"
              />
            )}
            {/* Label (optional) */}
            {showLabel && (
              <input
                type="text"
                value={range.label || ''}
                onChange={(e) => updateRange(idx, 'label', e.target.value)}
                className="w-16 px-2 py-1 text-xs border border-gray-300 rounded"
                placeholder="Label"
                aria-label="Range label"
              />
            )}
            {/* Remove */}
            <button
              type="button"
              onClick={() => removeRange(idx)}
              className="text-red-400 hover:text-red-600 transition-colors p-0.5"
              aria-label="Remove range"
              data-testid="remove-range-btn"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
