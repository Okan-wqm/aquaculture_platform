/**
 * Configuration panel for the SVG Path/Polyline widget.
 * Provides path-specific controls: closed toggle, point list,
 * fill/stroke properties, and the shared TransformConfig.
 *
 * The actual interactive point editing happens via PathOverlay
 * rendered on the canvas -- this panel provides the properties.
 */

import React, { useCallback } from 'react';
import { StrokeConfig } from './StrokeConfig';
import { TransformConfig } from './TransformConfig';
import type { StrokeDashPattern, StrokeLineCap, StrokeLineJoin } from '../../../types/scada-svg-properties.types';
import type { SvgTransform } from '../../../types/scada-transform.types';
import { DEFAULT_SVG_TRANSFORM } from '../../../types/scada-transform.types';
import type { PathPoint } from '../../../types/scada-path.types';

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

/** Default triangle path used when resetting to defaults */
const DEFAULT_TRIANGLE_POINTS: PathPoint[] = [
  { x: 50, y: 10, type: 'line' },
  { x: 90, y: 80, type: 'line' },
  { x: 10, y: 80, type: 'line' },
];

export const SvgPathConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  const closed = (config.closed as boolean) ?? false;
  const points = (config.points as PathPoint[]) || [];
  const transform = (config.transform as SvgTransform) ?? DEFAULT_SVG_TRANSFORM;

  const handleResetPath = useCallback(() => {
    onChange({
      points: DEFAULT_TRIANGLE_POINTS,
      closed: true,
    });
  }, [onChange]);

  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Path</div>

      {/* Closed path toggle */}
      <div>
        <label className="flex items-center gap-2 text-xs text-gray-500">
          <input
            type="checkbox"
            checked={closed}
            onChange={(e) => onChange({ closed: e.target.checked })}
            className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
            aria-label="Close path"
          />
          Closed path (connects last point to first)
        </label>
      </div>

      {/* Point count (read-only) */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Points</label>
        <div className="px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-lg text-gray-600">
          {points.length} point{points.length !== 1 ? 's' : ''}
        </div>
        <p className="text-[10px] text-gray-400 mt-0.5">
          Edit points by dragging handles directly on the canvas.
        </p>
      </div>

      {/* Fill -- only meaningful when closed */}
      {closed && (
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Fill</div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Fill</label>
              <input
                type="color"
                value={(config.fill as string) || '#3b82f6'}
                onChange={(e) => onChange({ fill: e.target.value })}
                className="w-full h-8 rounded-lg border border-gray-300 cursor-pointer"
                aria-label="Fill color"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Fill Opacity</label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={(config.fillOpacity as number) ?? 0.3}
                onChange={(e) => onChange({ fillOpacity: Number(e.target.value) })}
                className="w-full"
                aria-label="Fill opacity"
              />
              <div className="text-xs text-gray-400 text-right">
                {Math.round(((config.fillOpacity as number) ?? 0.3) * 100)}%
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Stroke section */}
      <StrokeConfig
        stroke={(config.stroke as string) || '#1d4ed8'}
        strokeWidth={(config.strokeWidth as number) ?? 2}
        strokeOpacity={(config.strokeOpacity as number) ?? 1}
        dashPattern={(config.dashPattern as StrokeDashPattern) || 'solid'}
        lineCap={(config.lineCap as StrokeLineCap) || 'round'}
        lineJoin={(config.lineJoin as StrokeLineJoin) || 'round'}
        onChange={(updates) => onChange(updates)}
      />

      {/* Transform section */}
      <TransformConfig
        transform={transform}
        onChange={(updates) => onChange({ transform: { ...transform, ...updates } })}
      />

      {/* Reset path */}
      <button
        type="button"
        onClick={handleResetPath}
        className="w-full py-1.5 text-xs text-gray-500 hover:text-red-500 border border-gray-200 hover:border-red-200 rounded-lg transition-colors"
        aria-label="Reset path to default"
      >
        Reset to Default Triangle
      </button>
    </div>
  );
};
