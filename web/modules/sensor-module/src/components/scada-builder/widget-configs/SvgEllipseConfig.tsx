/**
 * Configuration panel for the SVG Ellipse widget.
 * Follows the same pattern as SvgRectConfig/SvgCircleConfig but
 * for ellipses, which have independent rx/ry radii.
 *
 * Includes fill/stroke controls, label, and shared panels
 * for StrokeConfig and TransformConfig.
 */

import React from 'react';
import { StrokeConfig } from './StrokeConfig';
import { TransformConfig } from './TransformConfig';
import type { StrokeDashPattern, StrokeLineCap, StrokeLineJoin } from '../../../types/scada-svg-properties.types';
import type { SvgTransform } from '../../../types/scada-transform.types';
import { DEFAULT_SVG_TRANSFORM } from '../../../types/scada-transform.types';

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

const INPUT_CLASS =
  'w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500';

export const SvgEllipseConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => {
  const transform = (config.transform as SvgTransform) ?? DEFAULT_SVG_TRANSFORM;

  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Fill</div>
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
            value={(config.fillOpacity as number) ?? 1}
            onChange={(e) => onChange({ fillOpacity: Number(e.target.value) })}
            className="w-full"
            aria-label="Fill opacity"
          />
          <div className="text-xs text-gray-400 text-right">
            {Math.round(((config.fillOpacity as number) ?? 1) * 100)}%
          </div>
        </div>
      </div>

      {/* Stroke section -- delegated to shared StrokeConfig */}
      <StrokeConfig
        stroke={(config.stroke as string) || '#1d4ed8'}
        strokeWidth={(config.strokeWidth as number) ?? 2}
        strokeOpacity={(config.strokeOpacity as number) ?? 1}
        dashPattern={(config.dashPattern as StrokeDashPattern) || 'solid'}
        lineCap={(config.lineCap as StrokeLineCap) || 'round'}
        lineJoin={(config.lineJoin as StrokeLineJoin) || 'miter'}
        onChange={(updates) => onChange(updates)}
      />

      {/* Label */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Label</label>
        <input
          type="text"
          value={(config.label as string) || ''}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Optional label"
          className={INPUT_CLASS}
          aria-label="Widget label"
        />
      </div>

      {/* Transform section -- shared across all widget types */}
      <TransformConfig
        transform={transform}
        onChange={(updates) => onChange({ transform: { ...transform, ...updates } })}
      />
    </div>
  );
};
