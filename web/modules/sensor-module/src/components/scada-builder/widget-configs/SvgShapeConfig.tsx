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
import type {
  StrokeDashPattern,
  StrokeLineCap,
  StrokeLineJoin,
  GradientConfig,
  SvgFilterConfig,
} from '../../../types/scada-svg-properties.types';
import { DEFAULT_GRADIENT, DEFAULT_FILTER } from '../../../types/scada-svg-properties.types';
import type { SvgTransform } from '../../../types/scada-transform.types';
import { DEFAULT_SVG_TRANSFORM } from '../../../types/scada-transform.types';
import {
  Checkbox,
  ColorInput,
  colors as themeColors,
  Input,
  NumberInput,
  Select,
  Slider,
} from '@aquaculture/shared-ui';

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

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

    <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
      Fill
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <div className="sm:col-span-2">
        <ColorAlphaInput
          color={(config.fill as string) || themeColors.info[500]}
          alpha={(config.opacity as number) ?? 1}
          onChange={(color, alpha) => onChange({ fill: color, opacity: alpha })}
          label="Fill Color"
        />
      </div>
      <NumberInput
        label="Corner Radius"
        min={0}
        max={100}
        value={(config.cornerRadius as number) ?? 0}
        onChange={(e) => onChange({ cornerRadius: Number(e.target.value) })}
        aria-label="Corner radius"
      />
    </div>

    {/* Gradient editor -- overrides flat fill when type is not 'none' */}
    <GradientEditor
      gradient={getGradient(config)}
      onChange={(gradient) => onChange({ fillGradient: gradient })}
      widgetId={(config._widgetId as string) ?? 'rect-0'}
    />

    {/* Stroke -- delegated to shared StrokeConfig panel */}
    <StrokeConfig
      stroke={(config.stroke as string) || themeColors.info[700]}
      strokeWidth={(config.strokeWidth as number) ?? 2}
      strokeOpacity={(config.strokeOpacity as number) ?? 1}
      dashPattern={(config.dashPattern as StrokeDashPattern) || 'solid'}
      lineCap={(config.lineCap as StrokeLineCap) || 'butt'}
      lineJoin={(config.lineJoin as StrokeLineJoin) || 'miter'}
      onChange={(updates) => onChange(updates)}
    />

    <Input
      label="Label"
      value={(config.label as string) || ''}
      onChange={(e) => onChange({ label: e.target.value })}
      placeholder="Optional label"
      aria-label="Widget label"
    />

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

    <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
      Fill
    </div>
    <ColorAlphaInput
      color={(config.fill as string) || themeColors.info[500]}
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
      stroke={(config.stroke as string) || themeColors.info[700]}
      strokeWidth={(config.strokeWidth as number) ?? 2}
      strokeOpacity={(config.strokeOpacity as number) ?? 1}
      dashPattern={(config.dashPattern as StrokeDashPattern) || 'solid'}
      lineCap={(config.lineCap as StrokeLineCap) || 'butt'}
      lineJoin={(config.lineJoin as StrokeLineJoin) || 'miter'}
      onChange={(updates) => onChange(updates)}
    />

    <Input
      label="Label"
      value={(config.label as string) || ''}
      onChange={(e) => onChange({ label: e.target.value })}
      placeholder="Optional label"
      aria-label="Widget label"
    />

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

    <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
      Line
    </div>
    <div>
      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Direction</label>
      <Select
        value={(config.lineDirection as string) || 'horizontal'}
        onChange={(e) => onChange({ lineDirection: e.target.value })}
        aria-label="Line direction"
        options={[
          { value: 'horizontal', label: 'Horizontal' },
          { value: 'vertical', label: 'Vertical' },
          { value: 'diagonal-tl', label: 'Diagonal (Top-Left to Bottom-Right)' },
          { value: 'diagonal-tr', label: 'Diagonal (Top-Right to Bottom-Left)' },
        ]}
      />
    </div>

    {/* Stroke -- delegated to shared StrokeConfig panel */}
    <StrokeConfig
      stroke={(config.stroke as string) || themeColors.info[700]}
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

    <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
      Text
    </div>
    <Input
      label="Text"
      value={(config.text as string) || ''}
      onChange={(e) => onChange({ text: e.target.value })}
      placeholder="Enter text"
      aria-label="Text content"
    />
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <NumberInput
        label="Font Size"
        min={8}
        max={120}
        value={(config.fontSize as number) ?? 16}
        onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
        aria-label="Font size"
      />
      <div>
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Weight</label>
        <Select
          value={(config.fontWeight as string) || 'normal'}
          onChange={(e) => onChange({ fontWeight: e.target.value })}
          aria-label="Font weight"
          options={[
            { value: 'light', label: 'Light' },
            { value: 'normal', label: 'Normal' },
            { value: 'bold', label: 'Bold' },
          ]}
        />
      </div>
    </div>
    <ColorInput
      label="Color"
      aria-label="Text color"
      value={(config.color as string) || themeColors.neutral[800]}
      onChange={(e) => onChange({ color: e.target.value })}
    />
    <div>
      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Alignment</label>
      <Select
        value={(config.textAlign as string) || 'center'}
        onChange={(e) => onChange({ textAlign: e.target.value })}
        aria-label="Text alignment"
        options={[
          { value: 'left', label: 'Left' },
          { value: 'center', label: 'Center' },
          { value: 'right', label: 'Right' },
        ]}
      />
    </div>
    <div>
      <Checkbox
        label="Show live tag value"
        checked={(config.showValue as boolean) ?? false}
        onChange={(e) => onChange({ showValue: e.target.checked })}
      />
    </div>

    {/* Stroke -- optional for text outlines */}
    <StrokeConfig
      stroke={(config.stroke as string) || themeColors.black}
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
    <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
      Polygon
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <NumberInput
        label="Sides"
        min={3}
        max={12}
        value={(config.sides as number) ?? 6}
        onChange={(e) => onChange({ sides: Number(e.target.value) })}
        aria-label="Number of sides"
      />
      <div>
        <Checkbox
          label="Star Mode"
          checked={(config.starMode as boolean) ?? false}
          onChange={(e) => onChange({ starMode: e.target.checked })}
        />
      </div>
    </div>
    {(config.starMode as boolean) && (
      <div>
        <Slider
          size="xs"
          label="Inner Radius Ratio"
          readout="below"
          min={0.1}
          max={0.9}
          step={0.05}
          value={(config.innerRadius as number) ?? 0.5}
          onChange={(innerRadius) => onChange({ innerRadius })}
        />
      </div>
    )}
    <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
      Fill
    </div>
    <ColorAlphaInput
      color={(config.fill as string) || themeColors.info[500]}
      alpha={(config.opacity as number) ?? 1}
      onChange={(color, alpha) => onChange({ fill: color, opacity: alpha })}
      label="Fill Color"
    />
    <GradientEditor
      gradient={getGradient(config)}
      onChange={(gradient) => onChange({ fillGradient: gradient })}
      widgetId={(config._widgetId as string) ?? 'polygon-0'}
    />
    <StrokeConfig
      stroke={(config.stroke as string) || themeColors.info[700]}
      strokeWidth={(config.strokeWidth as number) ?? 2}
      strokeOpacity={(config.strokeOpacity as number) ?? 1}
      dashPattern={(config.dashPattern as StrokeDashPattern) || 'solid'}
      lineCap={(config.lineCap as StrokeLineCap) || 'butt'}
      lineJoin={(config.lineJoin as StrokeLineJoin) || 'miter'}
      onChange={(updates) => onChange(updates)}
    />
    <Input
      label="Label"
      value={(config.label as string) || ''}
      onChange={(e) => onChange({ label: e.target.value })}
      placeholder="Optional label"
      aria-label="Widget label"
    />
    <SvgFilterEditor
      filter={getFilter(config)}
      onChange={(filter) => onChange({ filter })}
      widgetId={(config._widgetId as string) ?? 'polygon-0'}
    />
    <TransformConfig
      transform={getTransform(config)}
      onChange={makeTransformOnChange(config, onChange)}
    />
  </div>
);

/* ------------------------------------------------------------------ */
/*  svgTriangle config                                                 */
/* ------------------------------------------------------------------ */

export const SvgTriangleConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => (
  <div className="space-y-3">
    <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
      Triangle
    </div>
    <div>
      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Direction</label>
      <Select
        value={(config.direction as string) || 'up'}
        onChange={(e) => onChange({ direction: e.target.value })}
        aria-label="Triangle direction"
        options={[
          { value: 'up', label: 'Up' },
          { value: 'down', label: 'Down' },
          { value: 'left', label: 'Left' },
          { value: 'right', label: 'Right' },
        ]}
      />
    </div>
    <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
      Fill
    </div>
    <ColorAlphaInput
      color={(config.fill as string) || themeColors.success[500]}
      alpha={(config.opacity as number) ?? 1}
      onChange={(color, alpha) => onChange({ fill: color, opacity: alpha })}
      label="Fill Color"
    />
    <GradientEditor
      gradient={getGradient(config)}
      onChange={(gradient) => onChange({ fillGradient: gradient })}
      widgetId={(config._widgetId as string) ?? 'triangle-0'}
    />
    <StrokeConfig
      stroke={(config.stroke as string) || themeColors.success[600]}
      strokeWidth={(config.strokeWidth as number) ?? 2}
      strokeOpacity={(config.strokeOpacity as number) ?? 1}
      dashPattern={(config.dashPattern as StrokeDashPattern) || 'solid'}
      lineCap={(config.lineCap as StrokeLineCap) || 'butt'}
      lineJoin={(config.lineJoin as StrokeLineJoin) || 'miter'}
      onChange={(updates) => onChange(updates)}
    />
    <Input
      label="Label"
      value={(config.label as string) || ''}
      onChange={(e) => onChange({ label: e.target.value })}
      placeholder="Optional label"
      aria-label="Widget label"
    />
    <SvgFilterEditor
      filter={getFilter(config)}
      onChange={(filter) => onChange({ filter })}
      widgetId={(config._widgetId as string) ?? 'triangle-0'}
    />
    <TransformConfig
      transform={getTransform(config)}
      onChange={makeTransformOnChange(config, onChange)}
    />
  </div>
);

/* ------------------------------------------------------------------ */
/*  svgDiamond config                                                  */
/* ------------------------------------------------------------------ */

export const SvgDiamondConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => (
  <div className="space-y-3">
    <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
      Fill
    </div>
    <ColorAlphaInput
      color={(config.fill as string) || themeColors.warning[500]}
      alpha={(config.opacity as number) ?? 1}
      onChange={(color, alpha) => onChange({ fill: color, opacity: alpha })}
      label="Fill Color"
    />
    <GradientEditor
      gradient={getGradient(config)}
      onChange={(gradient) => onChange({ fillGradient: gradient })}
      widgetId={(config._widgetId as string) ?? 'diamond-0'}
    />
    <StrokeConfig
      stroke={(config.stroke as string) || themeColors.warning[600]}
      strokeWidth={(config.strokeWidth as number) ?? 2}
      strokeOpacity={(config.strokeOpacity as number) ?? 1}
      dashPattern={(config.dashPattern as StrokeDashPattern) || 'solid'}
      lineCap={(config.lineCap as StrokeLineCap) || 'butt'}
      lineJoin={(config.lineJoin as StrokeLineJoin) || 'miter'}
      onChange={(updates) => onChange(updates)}
    />
    <Input
      label="Label"
      value={(config.label as string) || ''}
      onChange={(e) => onChange({ label: e.target.value })}
      placeholder="Optional label"
      aria-label="Widget label"
    />
    <SvgFilterEditor
      filter={getFilter(config)}
      onChange={(filter) => onChange({ filter })}
      widgetId={(config._widgetId as string) ?? 'diamond-0'}
    />
    <TransformConfig
      transform={getTransform(config)}
      onChange={makeTransformOnChange(config, onChange)}
    />
  </div>
);

/* ------------------------------------------------------------------ */
/*  svgArrow config                                                    */
/* ------------------------------------------------------------------ */

export const SvgArrowConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => (
  <div className="space-y-3">
    <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
      Arrow
    </div>
    <div>
      <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Direction</label>
      <Select
        value={(config.direction as string) || 'right'}
        onChange={(e) => onChange({ direction: e.target.value })}
        aria-label="Arrow direction"
        options={[
          { value: 'right', label: 'Right' },
          { value: 'left', label: 'Left' },
          { value: 'up', label: 'Up' },
          { value: 'down', label: 'Down' },
        ]}
      />
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <div>
        <Slider
          size="xs"
          label="Head Width"
          readout="below"
          min={0.3}
          max={1}
          step={0.05}
          value={(config.headWidthRatio as number) ?? 0.6}
          onChange={(headWidthRatio) => onChange({ headWidthRatio })}
        />
      </div>
      <div>
        <Slider
          size="xs"
          label="Body Width"
          readout="below"
          min={0.2}
          max={0.8}
          step={0.05}
          value={(config.bodyWidthRatio as number) ?? 0.5}
          onChange={(bodyWidthRatio) => onChange({ bodyWidthRatio })}
        />
      </div>
    </div>
    <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
      Fill
    </div>
    <ColorAlphaInput
      color={(config.fill as string) || themeColors.primary[500]}
      alpha={(config.opacity as number) ?? 1}
      onChange={(color, alpha) => onChange({ fill: color, opacity: alpha })}
      label="Fill Color"
    />
    <GradientEditor
      gradient={getGradient(config)}
      onChange={(gradient) => onChange({ fillGradient: gradient })}
      widgetId={(config._widgetId as string) ?? 'arrow-0'}
    />
    <StrokeConfig
      stroke={(config.stroke as string) || themeColors.primary[600]}
      strokeWidth={(config.strokeWidth as number) ?? 2}
      strokeOpacity={(config.strokeOpacity as number) ?? 1}
      dashPattern={(config.dashPattern as StrokeDashPattern) || 'solid'}
      lineCap={(config.lineCap as StrokeLineCap) || 'butt'}
      lineJoin={(config.lineJoin as StrokeLineJoin) || 'miter'}
      onChange={(updates) => onChange(updates)}
    />
    <Input
      label="Label"
      value={(config.label as string) || ''}
      onChange={(e) => onChange({ label: e.target.value })}
      placeholder="Optional label"
      aria-label="Widget label"
    />
    <SvgFilterEditor
      filter={getFilter(config)}
      onChange={(filter) => onChange({ filter })}
      widgetId={(config._widgetId as string) ?? 'arrow-0'}
    />
    <TransformConfig
      transform={getTransform(config)}
      onChange={makeTransformOnChange(config, onChange)}
    />
  </div>
);
