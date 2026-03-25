/**
 * SvgShapeConfig - Shared config panels for SVG shape widgets.
 *
 * Renders different fields based on the current widget type:
 * - svgRect:   tag binding, fill, gradient, filter, stroke (via StrokeConfig), cornerRadius, opacity, label, transform
 * - svgCircle: tag binding, fill, gradient, filter, stroke (via StrokeConfig), opacity, label, transform
 * - svgLine:   tag binding, lineDirection, stroke (via StrokeConfig), transform
 * - svgText:   tag binding, text, fontSize, fontWeight, color, textAlign, showValue, transform
 *
 * Phase 6: Added GradientEditor and SvgFilterEditor sections for shapes
 * that support fill (svgRect, svgCircle). ColorAlphaInput is used for
 * fill colors to provide per-color opacity control.
 *
 * Phase 7A: Added SvgTagBindingSection at the top of each config to
 * enable opt-in data binding for the animation/event/alarm pipeline.
 *
 * All shape configs use the shared StrokeConfig, TransformConfig,
 * GradientEditor, SvgFilterEditor, and SvgTagBindingSection panels
 * for consistent UI.
 */

import React from 'react';
import { StrokeConfig } from './StrokeConfig';
import { TransformConfig } from './TransformConfig';
import { GradientEditor } from './GradientEditor';
import { SvgFilterEditor } from './SvgFilterEditor';
import { ColorAlphaInput } from './ColorAlphaInput';
import { SvgTagBindingSection } from './SvgTagBindingSection';
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

/** Extract gradient config with fallback to defaults */
function getGradient(config: Record<string, unknown>): GradientConfig {
  return (config.fillGradient as GradientConfig) ?? DEFAULT_GRADIENT;
}

/** Extract filter config with fallback to defaults */
function getFilter(config: Record<string, unknown>): SvgFilterConfig {
  return (config.filter as SvgFilterConfig) ?? DEFAULT_FILTER;
}

/* ------------------------------------------------------------------ */
/*  svgRect config                                                     */
/* ------------------------------------------------------------------ */

export const SvgRectConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => (
  <div className="space-y-3">
    {/* Tag binding -- opt-in data binding for animation/event/alarm system */}
    <SvgTagBindingSection
      tagName={(config.tagName as string) || ''}
      onChange={onChange}
      deviceId={deviceId}
    />

    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Fill</div>
    <div className="grid grid-cols-2 gap-2">
      <div className="col-span-2">
        <ColorAlphaInput
          color={(config.fill as string) || '#3b82f6'}
          alpha={(config.opacity as number) ?? 1}
          onChange={(color, alpha) => onChange({ fill: color, opacity: alpha })}
          label="Fill Color"
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

    {/* Gradient editor -- overrides flat fill when type is not 'none' */}
    <GradientEditor
      gradient={getGradient(config)}
      onChange={(gradient) => onChange({ fillGradient: gradient })}
      widgetId={(config._widgetId as string) ?? 'rect-0'}
    />

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

    {/* SVG filter effects -- blur, shadow, glow */}
    <SvgFilterEditor
      filter={getFilter(config)}
      onChange={(filter) => onChange({ filter })}
      widgetId={(config._widgetId as string) ?? 'rect-0'}
    />

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

export const SvgCircleConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => (
  <div className="space-y-3">
    {/* Tag binding -- opt-in data binding for animation/event/alarm system */}
    <SvgTagBindingSection
      tagName={(config.tagName as string) || ''}
      onChange={onChange}
      deviceId={deviceId}
    />

    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Fill</div>
    <ColorAlphaInput
      color={(config.fill as string) || '#3b82f6'}
      alpha={(config.opacity as number) ?? 1}
      onChange={(color, alpha) => onChange({ fill: color, opacity: alpha })}
      label="Fill Color"
    />

    {/* Gradient editor -- overrides flat fill when type is not 'none' */}
    <GradientEditor
      gradient={getGradient(config)}
      onChange={(gradient) => onChange({ fillGradient: gradient })}
      widgetId={(config._widgetId as string) ?? 'circle-0'}
    />

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

    {/* SVG filter effects */}
    <SvgFilterEditor
      filter={getFilter(config)}
      onChange={(filter) => onChange({ filter })}
      widgetId={(config._widgetId as string) ?? 'circle-0'}
    />

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

export const SvgLineConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => (
  <div className="space-y-3">
    {/* Tag binding -- opt-in data binding for animation/event/alarm system */}
    <SvgTagBindingSection
      tagName={(config.tagName as string) || ''}
      onChange={onChange}
      deviceId={deviceId}
    />

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

export const SvgTextConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => (
  <div className="space-y-3">
    {/* Tag binding -- opt-in data binding for animation/event/alarm system */}
    <SvgTagBindingSection
      tagName={(config.tagName as string) || ''}
      onChange={onChange}
      deviceId={deviceId}
    />

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

/* ------------------------------------------------------------------ */
/*  svgPolygon config                                                  */
/* ------------------------------------------------------------------ */

export const SvgPolygonConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => (
  <div className="space-y-3">
    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Polygon</div>
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Sides</label>
        <input
          type="number"
          min={3}
          max={12}
          value={(config.sides as number) ?? 6}
          onChange={(e) => onChange({ sides: Number(e.target.value) })}
          className={INPUT_CLASS}
          aria-label="Number of sides"
        />
      </div>
      <div>
        <label className="flex items-center gap-2 text-xs text-gray-500 mt-5">
          <input
            type="checkbox"
            checked={(config.starMode as boolean) ?? false}
            onChange={(e) => onChange({ starMode: e.target.checked })}
            className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
          />
          Star Mode
        </label>
      </div>
    </div>
    {(config.starMode as boolean) && (
      <div>
        <label className="block text-xs text-gray-500 mb-1">Inner Radius Ratio</label>
        <input
          type="range"
          min={0.1}
          max={0.9}
          step={0.05}
          value={(config.innerRadius as number) ?? 0.5}
          onChange={(e) => onChange({ innerRadius: Number(e.target.value) })}
          className="w-full"
          aria-label="Inner radius ratio"
        />
        <span className="text-[10px] text-gray-400">{((config.innerRadius as number) ?? 0.5).toFixed(2)}</span>
      </div>
    )}
    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Fill</div>
    <ColorAlphaInput color={(config.fill as string) || '#3b82f6'} alpha={(config.opacity as number) ?? 1} onChange={(color, alpha) => onChange({ fill: color, opacity: alpha })} label="Fill Color" />
    <GradientEditor gradient={getGradient(config)} onChange={(gradient) => onChange({ fillGradient: gradient })} widgetId={(config._widgetId as string) ?? 'polygon-0'} />
    <StrokeConfig stroke={(config.stroke as string) || '#1d4ed8'} strokeWidth={(config.strokeWidth as number) ?? 2} strokeOpacity={(config.strokeOpacity as number) ?? 1} dashPattern={(config.dashPattern as StrokeDashPattern) || 'solid'} lineCap={(config.lineCap as StrokeLineCap) || 'butt'} lineJoin={(config.lineJoin as StrokeLineJoin) || 'miter'} onChange={(updates) => onChange(updates)} />
    <div><label className="block text-xs text-gray-500 mb-1">Label</label><input type="text" value={(config.label as string) || ''} onChange={(e) => onChange({ label: e.target.value })} placeholder="Optional label" className={INPUT_CLASS} aria-label="Widget label" /></div>
    <SvgFilterEditor filter={getFilter(config)} onChange={(filter) => onChange({ filter })} widgetId={(config._widgetId as string) ?? 'polygon-0'} />
    <TransformConfig transform={getTransform(config)} onChange={makeTransformOnChange(config, onChange)} />
  </div>
);

/* ------------------------------------------------------------------ */
/*  svgTriangle config                                                 */
/* ------------------------------------------------------------------ */

export const SvgTriangleConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => (
  <div className="space-y-3">
    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Triangle</div>
    <div>
      <label className="block text-xs text-gray-500 mb-1">Direction</label>
      <select value={(config.direction as string) || 'up'} onChange={(e) => onChange({ direction: e.target.value })} className={INPUT_CLASS} aria-label="Triangle direction">
        <option value="up">Up</option>
        <option value="down">Down</option>
        <option value="left">Left</option>
        <option value="right">Right</option>
      </select>
    </div>
    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Fill</div>
    <ColorAlphaInput color={(config.fill as string) || '#10b981'} alpha={(config.opacity as number) ?? 1} onChange={(color, alpha) => onChange({ fill: color, opacity: alpha })} label="Fill Color" />
    <GradientEditor gradient={getGradient(config)} onChange={(gradient) => onChange({ fillGradient: gradient })} widgetId={(config._widgetId as string) ?? 'triangle-0'} />
    <StrokeConfig stroke={(config.stroke as string) || '#059669'} strokeWidth={(config.strokeWidth as number) ?? 2} strokeOpacity={(config.strokeOpacity as number) ?? 1} dashPattern={(config.dashPattern as StrokeDashPattern) || 'solid'} lineCap={(config.lineCap as StrokeLineCap) || 'butt'} lineJoin={(config.lineJoin as StrokeLineJoin) || 'miter'} onChange={(updates) => onChange(updates)} />
    <div><label className="block text-xs text-gray-500 mb-1">Label</label><input type="text" value={(config.label as string) || ''} onChange={(e) => onChange({ label: e.target.value })} placeholder="Optional label" className={INPUT_CLASS} aria-label="Widget label" /></div>
    <SvgFilterEditor filter={getFilter(config)} onChange={(filter) => onChange({ filter })} widgetId={(config._widgetId as string) ?? 'triangle-0'} />
    <TransformConfig transform={getTransform(config)} onChange={makeTransformOnChange(config, onChange)} />
  </div>
);

/* ------------------------------------------------------------------ */
/*  svgDiamond config                                                  */
/* ------------------------------------------------------------------ */

export const SvgDiamondConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => (
  <div className="space-y-3">
    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Fill</div>
    <ColorAlphaInput color={(config.fill as string) || '#f59e0b'} alpha={(config.opacity as number) ?? 1} onChange={(color, alpha) => onChange({ fill: color, opacity: alpha })} label="Fill Color" />
    <GradientEditor gradient={getGradient(config)} onChange={(gradient) => onChange({ fillGradient: gradient })} widgetId={(config._widgetId as string) ?? 'diamond-0'} />
    <StrokeConfig stroke={(config.stroke as string) || '#d97706'} strokeWidth={(config.strokeWidth as number) ?? 2} strokeOpacity={(config.strokeOpacity as number) ?? 1} dashPattern={(config.dashPattern as StrokeDashPattern) || 'solid'} lineCap={(config.lineCap as StrokeLineCap) || 'butt'} lineJoin={(config.lineJoin as StrokeLineJoin) || 'miter'} onChange={(updates) => onChange(updates)} />
    <div><label className="block text-xs text-gray-500 mb-1">Label</label><input type="text" value={(config.label as string) || ''} onChange={(e) => onChange({ label: e.target.value })} placeholder="Optional label" className={INPUT_CLASS} aria-label="Widget label" /></div>
    <SvgFilterEditor filter={getFilter(config)} onChange={(filter) => onChange({ filter })} widgetId={(config._widgetId as string) ?? 'diamond-0'} />
    <TransformConfig transform={getTransform(config)} onChange={makeTransformOnChange(config, onChange)} />
  </div>
);

/* ------------------------------------------------------------------ */
/*  svgArrow config                                                    */
/* ------------------------------------------------------------------ */

export const SvgArrowConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => (
  <div className="space-y-3">
    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Arrow</div>
    <div>
      <label className="block text-xs text-gray-500 mb-1">Direction</label>
      <select value={(config.direction as string) || 'right'} onChange={(e) => onChange({ direction: e.target.value })} className={INPUT_CLASS} aria-label="Arrow direction">
        <option value="right">Right</option>
        <option value="left">Left</option>
        <option value="up">Up</option>
        <option value="down">Down</option>
      </select>
    </div>
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Head Width</label>
        <input type="range" min={0.3} max={1} step={0.05} value={(config.headWidthRatio as number) ?? 0.6} onChange={(e) => onChange({ headWidthRatio: Number(e.target.value) })} className="w-full" aria-label="Arrow head width ratio" />
        <span className="text-[10px] text-gray-400">{((config.headWidthRatio as number) ?? 0.6).toFixed(2)}</span>
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Body Width</label>
        <input type="range" min={0.2} max={0.8} step={0.05} value={(config.bodyWidthRatio as number) ?? 0.5} onChange={(e) => onChange({ bodyWidthRatio: Number(e.target.value) })} className="w-full" aria-label="Arrow body width ratio" />
        <span className="text-[10px] text-gray-400">{((config.bodyWidthRatio as number) ?? 0.5).toFixed(2)}</span>
      </div>
    </div>
    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Fill</div>
    <ColorAlphaInput color={(config.fill as string) || '#6366f1'} alpha={(config.opacity as number) ?? 1} onChange={(color, alpha) => onChange({ fill: color, opacity: alpha })} label="Fill Color" />
    <GradientEditor gradient={getGradient(config)} onChange={(gradient) => onChange({ fillGradient: gradient })} widgetId={(config._widgetId as string) ?? 'arrow-0'} />
    <StrokeConfig stroke={(config.stroke as string) || '#4f46e5'} strokeWidth={(config.strokeWidth as number) ?? 2} strokeOpacity={(config.strokeOpacity as number) ?? 1} dashPattern={(config.dashPattern as StrokeDashPattern) || 'solid'} lineCap={(config.lineCap as StrokeLineCap) || 'butt'} lineJoin={(config.lineJoin as StrokeLineJoin) || 'miter'} onChange={(updates) => onChange(updates)} />
    <div><label className="block text-xs text-gray-500 mb-1">Label</label><input type="text" value={(config.label as string) || ''} onChange={(e) => onChange({ label: e.target.value })} placeholder="Optional label" className={INPUT_CLASS} aria-label="Widget label" /></div>
    <SvgFilterEditor filter={getFilter(config)} onChange={(filter) => onChange({ filter })} widgetId={(config._widgetId as string) ?? 'arrow-0'} />
    <TransformConfig transform={getTransform(config)} onChange={makeTransformOnChange(config, onChange)} />
  </div>
);
