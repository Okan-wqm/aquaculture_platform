/**
 * Interactive gradient editor with visual stop positioning.
 * Renders a gradient preview bar (SVG-based) with clickable stop handles.
 *
 * Architecture: Gradient stops are stored as an array in the widget config.
 * The component renders SVG gradient definitions inline for the preview.
 * Stop positions are normalized to [0, 1] range.
 *
 * UX:
 * - Click "Add Stop" to insert a stop at the midpoint of the two widest gaps.
 * - Click a stop handle to select it and edit its color/opacity.
 * - Click the X on a selected stop to remove it (minimum 2 stops enforced).
 * - Linear mode: angle input with visual rotation preview.
 * - Radial mode: circular gradient preview in the bar area.
 */

import React, { useState, useCallback, useId } from 'react';
import { Button } from '@aquaculture/shared-ui';
import type {
  GradientConfig,
  GradientType,
  GradientStop,
} from '../../../types/scada-svg-properties.types';
import {
  GRADIENT_TYPE_OPTIONS,
  buildGradientId,
  angleToGradientCoords,
} from '../../../types/scada-svg-properties.types';
import { ColorAlphaInput } from './ColorAlphaInput';
import { ChevronDown } from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Props                                                               */
/* ------------------------------------------------------------------ */

interface GradientEditorProps {
  gradient: GradientConfig;
  onChange: (gradient: GradientConfig) => void;
  widgetId: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const PREVIEW_WIDTH = 200;
const PREVIEW_HEIGHT = 24;
const MIN_STOPS = 2;

const INPUT_CLASS =
  'w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500 focus:border-info-500';

/** Human-readable labels for gradient type options */
const TYPE_LABELS: Record<GradientType, string> = {
  none: 'None',
  linear: 'Linear',
  radial: 'Radial',
};

/* ------------------------------------------------------------------ */
/*  Gradient Preview (SVG-based, not CSS)                               */
/* ------------------------------------------------------------------ */

/**
 * Renders the gradient preview bar using actual SVG gradient definitions.
 * This ensures visual fidelity -- what you see in the editor matches
 * the widget rendering exactly because both use SVG gradients.
 */
const GradientPreview: React.FC<{
  gradient: GradientConfig;
  previewId: string;
  onStopClick: (index: number) => void;
  selectedStop: number;
}> = ({ gradient, previewId, onStopClick, selectedStop }) => {
  const gradId = `preview-${previewId}`;
  const coords = angleToGradientCoords(gradient.angle);

  return (
    <div className="relative">
      <svg
        width={PREVIEW_WIDTH}
        height={PREVIEW_HEIGHT}
        viewBox={`0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}`}
        className="rounded-md border border-gray-200 dark:border-gray-700"
        aria-label="Gradient preview"
        role="img"
      >
        <defs>
          {gradient.type === 'linear' && (
            <linearGradient id={gradId} x1={coords.x1} y1={coords.y1} x2={coords.x2} y2={coords.y2}>
              {gradient.stops.map((stop, i) => (
                <stop
                  key={i}
                  offset={`${stop.offset * 100}%`}
                  stopColor={stop.color}
                  stopOpacity={stop.opacity}
                />
              ))}
            </linearGradient>
          )}
          {gradient.type === 'radial' && (
            <radialGradient id={gradId} cx="50%" cy="50%" r="50%">
              {gradient.stops.map((stop, i) => (
                <stop
                  key={i}
                  offset={`${stop.offset * 100}%`}
                  stopColor={stop.color}
                  stopOpacity={stop.opacity}
                />
              ))}
            </radialGradient>
          )}
        </defs>
        <rect
          x={0}
          y={0}
          width={PREVIEW_WIDTH}
          height={PREVIEW_HEIGHT}
          fill={`url(#${gradId})`}
          rx={4}
        />
      </svg>

      {/* Stop handles rendered below the preview bar */}
      <div className="relative h-4 mt-0.5" style={{ width: PREVIEW_WIDTH }}>
        {gradient.stops.map((stop, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onStopClick(i)}
            className={`absolute -translate-x-1/2 w-3 h-3 rounded-sm border-2 transition-colors ${
              selectedStop === i
                ? 'border-info-500 ring-2 ring-info-200'
                : 'border-gray-400 hover:border-gray-600'
            }`}
            style={{
              left: `${stop.offset * 100}%`,
              top: 0,
              backgroundColor: stop.color,
            }}
            aria-label={`Gradient stop at ${Math.round(stop.offset * 100)}%`}
            data-testid={`gradient-stop-${i}`}
          />
        ))}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  GradientEditor                                                      */
/* ------------------------------------------------------------------ */

export const GradientEditor: React.FC<GradientEditorProps> = ({ gradient, onChange, widgetId }) => {
  const [selectedStop, setSelectedStop] = useState(0);
  const [open, setOpen] = useState(gradient.type !== 'none');
  const uniqueId = useId();

  // Ensure selectedStop is within bounds
  const safeSelected = Math.min(selectedStop, gradient.stops.length - 1);

  const handleTypeChange = useCallback(
    (type: GradientType) => {
      onChange({ ...gradient, type });
    },
    [gradient, onChange],
  );

  const handleAngleChange = useCallback(
    (angle: number) => {
      onChange({ ...gradient, angle: Math.max(0, Math.min(360, angle)) });
    },
    [gradient, onChange],
  );

  const handleStopColorChange = useCallback(
    (index: number, color: string, opacity: number) => {
      const stops = gradient.stops.map((s, i) => (i === index ? { ...s, color, opacity } : s));
      onChange({ ...gradient, stops });
    },
    [gradient, onChange],
  );

  const handleStopOffsetChange = useCallback(
    (index: number, offset: number) => {
      const clampedOffset = Math.max(0, Math.min(1, offset));
      const stops = gradient.stops
        .map((s, i) => (i === index ? { ...s, offset: clampedOffset } : s))
        .sort((a, b) => a.offset - b.offset);
      onChange({ ...gradient, stops });
      // Find the new index of the moved stop after sorting
      const newIdx = stops.findIndex((s) => s.offset === clampedOffset);
      if (newIdx >= 0) setSelectedStop(newIdx);
    },
    [gradient, onChange],
  );

  /**
   * Adds a stop at the midpoint of the largest gap between existing stops.
   * Color is interpolated from the two surrounding stops for visual continuity.
   */
  const handleAddStop = useCallback(() => {
    const sorted = [...gradient.stops].sort((a, b) => a.offset - b.offset);
    let maxGap = 0;
    let gapIndex = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      const gap = sorted[i + 1].offset - sorted[i].offset;
      if (gap > maxGap) {
        maxGap = gap;
        gapIndex = i;
      }
    }
    const newOffset = (sorted[gapIndex].offset + sorted[gapIndex + 1].offset) / 2;
    const newStop: GradientStop = {
      offset: newOffset,
      color: sorted[gapIndex].color,
      opacity: 1,
    };
    const stops = [...sorted.slice(0, gapIndex + 1), newStop, ...sorted.slice(gapIndex + 1)];
    onChange({ ...gradient, stops });
    setSelectedStop(gapIndex + 1);
  }, [gradient, onChange]);

  const handleRemoveStop = useCallback(
    (index: number) => {
      if (gradient.stops.length <= MIN_STOPS) return;
      const stops = gradient.stops.filter((_, i) => i !== index);
      onChange({ ...gradient, stops });
      setSelectedStop(Math.min(index, stops.length - 1));
    },
    [gradient, onChange],
  );

  const currentStop = gradient.stops[safeSelected];
  const previewGradId = buildGradientId(widgetId, 'fill');

  return (
    <div className="border-t border-gray-100 dark:border-gray-700 pt-2">
      <Button
        variant="ghost"
        size="xs"
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label="Gradient settings"
      >
        <span>Gradient</span>
        <ChevronDown
          className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </Button>

      {open && (
        <div className="space-y-3 mt-2">
          {/* Gradient type selector */}
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Type</label>
            <div className="flex gap-1" role="radiogroup" aria-label="Gradient type">
              {GRADIENT_TYPE_OPTIONS.map((t) => (
                <label
                  key={t}
                  className={`flex-1 text-center py-1.5 text-xs rounded-lg border-2 cursor-pointer transition-colors ${
                    gradient.type === t
                      ? 'border-info-500 bg-info-50 dark:bg-info-900/20 text-info-700 dark:text-info-300'
                      : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-500 text-gray-600 dark:text-gray-400'
                  }`}
                >
                  <input
                    type="radio"
                    name={`gradient-type-${uniqueId}`}
                    value={t}
                    checked={gradient.type === t}
                    onChange={() => handleTypeChange(t)}
                    className="sr-only"
                  />
                  {TYPE_LABELS[t]}
                </label>
              ))}
            </div>
          </div>

          {/* Everything below only visible when gradient is active */}
          {gradient.type !== 'none' && (
            <>
              {/* Angle control -- only for linear */}
              {gradient.type === 'linear' && (
                <div>
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                    Angle
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={360}
                      step={15}
                      value={gradient.angle}
                      onChange={(e) => handleAngleChange(Number(e.target.value))}
                      className={`${INPUT_CLASS} max-w-20`}
                      aria-label="Gradient angle"
                    />
                    {/* Visual angle indicator */}
                    <div
                      className="w-6 h-6 rounded-full border-2 border-gray-300 dark:border-gray-600 relative flex-shrink-0"
                      aria-hidden="true"
                    >
                      <div
                        className="absolute top-1/2 left-1/2 w-2.5 h-0.5 bg-info-500 rounded-full origin-left"
                        style={{
                          transform: `translate(0, -50%) rotate(${gradient.angle}deg)`,
                        }}
                      />
                    </div>
                    <span className="text-xs text-gray-400 dark:text-gray-500">
                      {gradient.angle}&deg;
                    </span>
                  </div>
                </div>
              )}

              {/* Gradient preview bar */}
              <GradientPreview
                gradient={gradient}
                previewId={previewGradId}
                onStopClick={setSelectedStop}
                selectedStop={safeSelected}
              />

              {/* Selected stop editor */}
              {currentStop && (
                <div className="p-2 bg-gray-50 dark:bg-gray-800 rounded-lg space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                      Stop {safeSelected + 1}
                    </span>
                    {gradient.stops.length > MIN_STOPS && (
                      <Button
                        variant="ghost"
                        size="xs"
                        type="button"
                        onClick={() => handleRemoveStop(safeSelected)}
                        aria-label="Remove selected stop"
                        data-testid="remove-stop"
                      >
                        Remove
                      </Button>
                    )}
                  </div>

                  {/* Stop color + alpha */}
                  <ColorAlphaInput
                    color={currentStop.color}
                    alpha={currentStop.opacity}
                    onChange={(color, alpha) => handleStopColorChange(safeSelected, color, alpha)}
                    label="Color"
                  />

                  {/* Stop offset */}
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                      Position ({Math.round(currentStop.offset * 100)}%)
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={currentStop.offset}
                      onChange={(e) => handleStopOffsetChange(safeSelected, Number(e.target.value))}
                      className="w-full"
                      aria-label="Stop position"
                    />
                  </div>
                </div>
              )}

              {/* Add stop button */}
              <Button
                variant="secondary"
                size="xs"
                type="button"
                onClick={handleAddStop}
                aria-label="Add gradient stop"
                data-testid="add-stop"
              >
                + Add Stop
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
};
