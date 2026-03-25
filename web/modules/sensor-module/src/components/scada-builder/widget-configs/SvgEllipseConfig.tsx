/**
 * Configuration panel for the SVG Ellipse widget.
 * Follows the same pattern as SvgRectConfig/SvgCircleConfig but
 * for ellipses, which have independent rx/ry radii.
 *
 * Phase 6: Added GradientEditor and SvgFilterEditor for gradient fill
 * and visual filter effects. ColorAlphaInput replaces the separate
 * fill color picker + opacity slider for a more compact UI.
 *
 * Includes fill/stroke controls, label, and shared panels
 * for StrokeConfig, TransformConfig, GradientEditor, and SvgFilterEditor.
 */

import React from 'react';
import { StrokeConfig } from './StrokeConfig';
import { TransformConfig } from './TransformConfig';
import { GradientEditor } from './GradientEditor';
import { SvgFilterEditor } from './SvgFilterEditor';
import { ColorAlphaInput } from './ColorAlphaInput';
import type { StrokeDashPattern, StrokeLineCap, StrokeLineJoin, GradientConfig, SvgFilterConfig } from '../../../types/scada-svg-properties.types';
import { DEFAULT_GRADIENT, DEFAULT_FILTER } from '../../../types/scada-svg-properties.types';
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
  const fillGradient = (config.fillGradient as GradientConfig) ?? DEFAULT_GRADIENT;
  const filterConfig = (config.filter as SvgFilterConfig) ?? DEFAULT_FILTER;

  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Fill</div>
      <ColorAlphaInput
        color={(config.fill as string) || '#3b82f6'}
        alpha={(config.fillOpacity as number) ?? 1}
        onChange={(color, alpha) => onChange({ fill: color, fillOpacity: alpha })}
        label="Fill Color"
      />

      {/* Gradient editor -- overrides flat fill when type is not 'none' */}
      <GradientEditor
        gradient={fillGradient}
        onChange={(gradient) => onChange({ fillGradient: gradient })}
        widgetId={(config._widgetId as string) ?? 'ellipse-0'}
      />

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

      {/* SVG filter effects -- blur, shadow, glow */}
      <SvgFilterEditor
        filter={filterConfig}
        onChange={(filter) => onChange({ filter })}
        widgetId={(config._widgetId as string) ?? 'ellipse-0'}
      />

      {/* Transform section -- shared across all widget types */}
      <TransformConfig
        transform={transform}
        onChange={(updates) => onChange({ transform: { ...transform, ...updates } })}
      />
    </div>
  );
};
