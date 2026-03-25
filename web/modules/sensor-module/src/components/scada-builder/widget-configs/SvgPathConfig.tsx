/**
 * Configuration panel for the SVG Path/Polyline widget.
 * Provides path-specific controls: closed toggle, point list,
 * fill/stroke properties, and the shared TransformConfig.
 *
 * The actual interactive point editing happens via PathOverlay
 * rendered on the canvas -- this panel provides the properties.
 *
 * Phase 7A: Added SvgTagBindingSection for opt-in data binding,
 * GradientEditor (visible when path is closed), and SvgFilterEditor
 * for visual filter effects. These were missing from the original
 * path config, creating an inconsistency with rect/circle/ellipse.
 */

import React, { useCallback } from 'react';
import { StrokeConfig } from './StrokeConfig';
import { TransformConfig } from './TransformConfig';
import { GradientEditor } from './GradientEditor';
import { SvgFilterEditor } from './SvgFilterEditor';
import { SvgTagBindingSection } from './SvgTagBindingSection';
import type { StrokeDashPattern, StrokeLineCap, StrokeLineJoin, GradientConfig, SvgFilterConfig } from '../../../types/scada-svg-properties.types';
import { DEFAULT_GRADIENT, DEFAULT_FILTER } from '../../../types/scada-svg-properties.types';
import type { SvgTransform } from '../../../types/scada-transform.types';
import { DEFAULT_SVG_TRANSFORM } from '../../../types/scada-transform.types';
import type { PathPoint } from '../../../types/scada-path.types';

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

const INPUT_CLASS =
  'w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500';

/** Default triangle path used when resetting to defaults */
const DEFAULT_TRIANGLE_POINTS: PathPoint[] = [
  { x: 50, y: 10, type: 'line' },
  { x: 90, y: 80, type: 'line' },
  { x: 10, y: 80, type: 'line' },
];

export const SvgPathConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
  const closed = (config.closed as boolean) ?? false;
  const points = (config.points as PathPoint[]) || [];
  const transform = (config.transform as SvgTransform) ?? DEFAULT_SVG_TRANSFORM;
  const fillGradient = (config.fillGradient as GradientConfig) ?? DEFAULT_GRADIENT;
  const filterConfig = (config.filter as SvgFilterConfig) ?? DEFAULT_FILTER;

  const handleResetPath = useCallback(() => {
    onChange({
      points: DEFAULT_TRIANGLE_POINTS,
      closed: true,
    });
  }, [onChange]);

  return (
    <div className="space-y-3">
      {/* Tag binding -- opt-in data binding for animation/event/alarm system */}
      <SvgTagBindingSection
        tagName={(config.tagName as string) || ''}
        onChange={onChange}
        deviceId={deviceId}
      />

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

      {/* Gradient editor -- only visible when path is closed (fill is meaningful) */}
      {closed && (
        <GradientEditor
          gradient={fillGradient}
          onChange={(gradient) => onChange({ fillGradient: gradient })}
          widgetId={(config._widgetId as string) ?? 'path-0'}
        />
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

      {/* SVG filter effects -- blur, shadow, glow */}
      <SvgFilterEditor
        filter={filterConfig}
        onChange={(filter) => onChange({ filter })}
        widgetId={(config._widgetId as string) ?? 'path-0'}
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
