/**
 * SvgShapeConfig - Shared config panels for SVG shape widgets.
 *
 * Renders different fields based on the current widget type:
 * - svgRect:   fill, stroke (via StrokeConfig), cornerRadius, opacity, label, transform
 * - svgCircle: fill, stroke (via StrokeConfig), opacity, label, transform
 * - svgLine:   lineDirection, stroke (via StrokeConfig), transform
 * - svgText:   text, fontSize, fontWeight, color, textAlign, showValue, transform
 *
 * All shape configs now use the shared StrokeConfig and TransformConfig panels
 * for consistent UI and richer stroke/transform controls.
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

/** Helper to extract transform from config with defaults */
function getTransform(config: Record<string, unknown>): SvgTransform {
  return (config.transform as SvgTransform) ?? DEFAULT_SVG_TRANSFORM;
}

/** Helper to build onChange for transform updates that merges with existing transform */
function makeTransformOnChange(
  config: Record<string, unknown>,
  onChange: (updates: Record<string, unknown>) => void,
): (updates: Partial<SvgTransform>) => void {
  return (updates: Partial<SvgTransform>) => {
    onChange({ transform: { ...getTransform(config), ...updates } });
  };
}

/* ------------------------------------------------------------------ */
/*  svgRect config                                                     */
/* ------------------------------------------------------------------ */

export const SvgRectConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => (
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
        <label className="block text-xs text-gray-500 mb-1">Corner Radius</label>
        <input
          type="number"
          min={0}
          max={100}
          value={(config.cornerRadius as number) ?? 0}
          onChange={(e) => onChange({ cornerRadius: Number(e.target.value) })}
          className={INPUT_CLASS}
          aria-label="Corner radius"
        />
      </div>
    </div>
    <div>
      <label className="block text-xs text-gray-500 mb-1">Opacity</label>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={(config.opacity as number) ?? 1}
        onChange={(e) => onChange({ opacity: Number(e.target.value) })}
        className="w-full"
        aria-label="Fill opacity"
      />
      <div className="text-xs text-gray-400 text-right">{((config.opacity as number) ?? 1).toFixed(2)}</div>
    </div>

    {/* Stroke -- delegated to shared StrokeConfig panel */}
    <StrokeConfig
      stroke={(config.stroke as string) || '#1d4ed8'}
      strokeWidth={(config.strokeWidth as number) ?? 2}
      strokeOpacity={(config.strokeOpacity as number) ?? 1}
      dashPattern={(config.dashPattern as StrokeDashPattern) || 'solid'}
      lineCap={(config.lineCap as StrokeLineCap) || 'butt'}
      lineJoin={(config.lineJoin as StrokeLineJoin) || 'miter'}
      onChange={(updates) => onChange(updates)}
    />

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

    {/* Transform -- shared across all widget types */}
    <TransformConfig
      transform={getTransform(config)}
      onChange={makeTransformOnChange(config, onChange)}
    />
  </div>
);

/* ------------------------------------------------------------------ */
/*  svgCircle config                                                   */
/* ------------------------------------------------------------------ */

export const SvgCircleConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => (
  <div className="space-y-3">
    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Fill</div>
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
      <label className="block text-xs text-gray-500 mb-1">Opacity</label>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={(config.opacity as number) ?? 1}
        onChange={(e) => onChange({ opacity: Number(e.target.value) })}
        className="w-full"
        aria-label="Fill opacity"
      />
      <div className="text-xs text-gray-400 text-right">{((config.opacity as number) ?? 1).toFixed(2)}</div>
    </div>

    {/* Stroke -- delegated to shared StrokeConfig panel */}
    <StrokeConfig
      stroke={(config.stroke as string) || '#1d4ed8'}
      strokeWidth={(config.strokeWidth as number) ?? 2}
      strokeOpacity={(config.strokeOpacity as number) ?? 1}
      dashPattern={(config.dashPattern as StrokeDashPattern) || 'solid'}
      lineCap={(config.lineCap as StrokeLineCap) || 'butt'}
      lineJoin={(config.lineJoin as StrokeLineJoin) || 'miter'}
      onChange={(updates) => onChange(updates)}
    />

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

    {/* Transform -- shared across all widget types */}
    <TransformConfig
      transform={getTransform(config)}
      onChange={makeTransformOnChange(config, onChange)}
    />
  </div>
);

/* ------------------------------------------------------------------ */
/*  svgLine config                                                     */
/* ------------------------------------------------------------------ */

export const SvgLineConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => (
  <div className="space-y-3">
    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Line</div>
    <div>
      <label className="block text-xs text-gray-500 mb-1">Direction</label>
      <select
        value={(config.lineDirection as string) || 'horizontal'}
        onChange={(e) => onChange({ lineDirection: e.target.value })}
        className={INPUT_CLASS}
        aria-label="Line direction"
      >
        <option value="horizontal">Horizontal</option>
        <option value="vertical">Vertical</option>
        <option value="diagonal-tl">Diagonal (Top-Left to Bottom-Right)</option>
        <option value="diagonal-tr">Diagonal (Top-Right to Bottom-Left)</option>
      </select>
    </div>

    {/* Stroke -- delegated to shared StrokeConfig panel */}
    <StrokeConfig
      stroke={(config.stroke as string) || '#1d4ed8'}
      strokeWidth={(config.strokeWidth as number) ?? 3}
      strokeOpacity={(config.strokeOpacity as number) ?? 1}
      dashPattern={(config.dashPattern as StrokeDashPattern) || 'solid'}
      lineCap={(config.lineCap as StrokeLineCap) || 'round'}
      lineJoin={(config.lineJoin as StrokeLineJoin) || 'miter'}
      onChange={(updates) => onChange(updates)}
    />

    {/* Transform -- shared across all widget types */}
    <TransformConfig
      transform={getTransform(config)}
      onChange={makeTransformOnChange(config, onChange)}
    />
  </div>
);

/* ------------------------------------------------------------------ */
/*  svgText config                                                     */
/* ------------------------------------------------------------------ */

export const SvgTextConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => (
  <div className="space-y-3">
    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Text</div>
    <div>
      <label className="block text-xs text-gray-500 mb-1">Text</label>
      <input
        type="text"
        value={(config.text as string) || ''}
        onChange={(e) => onChange({ text: e.target.value })}
        placeholder="Enter text"
        className={INPUT_CLASS}
        aria-label="Text content"
      />
    </div>
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Font Size</label>
        <input
          type="number"
          min={8}
          max={120}
          value={(config.fontSize as number) ?? 16}
          onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
          className={INPUT_CLASS}
          aria-label="Font size"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Weight</label>
        <select
          value={(config.fontWeight as string) || 'normal'}
          onChange={(e) => onChange({ fontWeight: e.target.value })}
          className={INPUT_CLASS}
          aria-label="Font weight"
        >
          <option value="light">Light</option>
          <option value="normal">Normal</option>
          <option value="bold">Bold</option>
        </select>
      </div>
    </div>
    <div>
      <label className="block text-xs text-gray-500 mb-1">Color</label>
      <input
        type="color"
        value={(config.color as string) || '#1f2937'}
        onChange={(e) => onChange({ color: e.target.value })}
        className="w-full h-8 rounded-lg border border-gray-300 cursor-pointer"
        aria-label="Text color"
      />
    </div>
    <div>
      <label className="block text-xs text-gray-500 mb-1">Alignment</label>
      <select
        value={(config.textAlign as string) || 'center'}
        onChange={(e) => onChange({ textAlign: e.target.value })}
        className={INPUT_CLASS}
        aria-label="Text alignment"
      >
        <option value="left">Left</option>
        <option value="center">Center</option>
        <option value="right">Right</option>
      </select>
    </div>
    <div>
      <label className="flex items-center gap-2 text-xs text-gray-500">
        <input
          type="checkbox"
          checked={(config.showValue as boolean) ?? false}
          onChange={(e) => onChange({ showValue: e.target.checked })}
          className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
        />
        Show live tag value
      </label>
    </div>

    {/* Stroke -- optional for text outlines */}
    <StrokeConfig
      stroke={(config.stroke as string) || '#000000'}
      strokeWidth={(config.strokeWidth as number) ?? 0}
      strokeOpacity={(config.strokeOpacity as number) ?? 1}
      dashPattern={(config.dashPattern as StrokeDashPattern) || 'solid'}
      lineCap={(config.lineCap as StrokeLineCap) || 'butt'}
      lineJoin={(config.lineJoin as StrokeLineJoin) || 'miter'}
      onChange={(updates) => onChange(updates)}
    />

    {/* Transform -- shared across all widget types */}
    <TransformConfig
      transform={getTransform(config)}
      onChange={makeTransformOnChange(config, onChange)}
    />
  </div>
);
