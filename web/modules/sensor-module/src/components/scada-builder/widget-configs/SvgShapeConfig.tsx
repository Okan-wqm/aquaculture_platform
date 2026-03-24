/**
 * SvgShapeConfig - Shared config panel for SVG shape widgets
 *
 * Renders different fields based on the current widget type:
 * - svgRect:   fill, stroke, strokeWidth, cornerRadius, opacity, label
 * - svgCircle: fill, stroke, strokeWidth, opacity, label
 * - svgLine:   stroke, strokeWidth, lineDirection, dashArray
 * - svgText:   text, fontSize, fontWeight, color, textAlign, showValue
 */

import React from 'react';

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

/* ------------------------------------------------------------------ */
/*  svgRect config                                                     */
/* ------------------------------------------------------------------ */

export const SvgRectConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => (
  <div className="space-y-3">
    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Fill & Stroke</div>
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Fill</label>
        <input
          type="color"
          value={(config.fill as string) || '#3b82f6'}
          onChange={(e) => onChange({ fill: e.target.value })}
          className="w-full h-8 rounded-lg border border-gray-300 cursor-pointer"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Stroke</label>
        <input
          type="color"
          value={(config.stroke as string) || '#1d4ed8'}
          onChange={(e) => onChange({ stroke: e.target.value })}
          className="w-full h-8 rounded-lg border border-gray-300 cursor-pointer"
        />
      </div>
    </div>
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Stroke Width</label>
        <input
          type="number"
          min={0}
          max={20}
          value={(config.strokeWidth as number) ?? 2}
          onChange={(e) => onChange({ strokeWidth: Number(e.target.value) })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
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
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
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
      />
      <div className="text-xs text-gray-400 text-right">{((config.opacity as number) ?? 1).toFixed(2)}</div>
    </div>
    <div>
      <label className="block text-xs text-gray-500 mb-1">Label</label>
      <input
        type="text"
        value={(config.label as string) || ''}
        onChange={(e) => onChange({ label: e.target.value })}
        placeholder="Optional label"
        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
      />
    </div>
  </div>
);

/* ------------------------------------------------------------------ */
/*  svgCircle config                                                   */
/* ------------------------------------------------------------------ */

export const SvgCircleConfig: React.FC<WidgetConfigProps> = ({ config, onChange }) => (
  <div className="space-y-3">
    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Fill & Stroke</div>
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Fill</label>
        <input
          type="color"
          value={(config.fill as string) || '#3b82f6'}
          onChange={(e) => onChange({ fill: e.target.value })}
          className="w-full h-8 rounded-lg border border-gray-300 cursor-pointer"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Stroke</label>
        <input
          type="color"
          value={(config.stroke as string) || '#1d4ed8'}
          onChange={(e) => onChange({ stroke: e.target.value })}
          className="w-full h-8 rounded-lg border border-gray-300 cursor-pointer"
        />
      </div>
    </div>
    <div>
      <label className="block text-xs text-gray-500 mb-1">Stroke Width</label>
      <input
        type="number"
        min={0}
        max={20}
        value={(config.strokeWidth as number) ?? 2}
        onChange={(e) => onChange({ strokeWidth: Number(e.target.value) })}
        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
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
      />
      <div className="text-xs text-gray-400 text-right">{((config.opacity as number) ?? 1).toFixed(2)}</div>
    </div>
    <div>
      <label className="block text-xs text-gray-500 mb-1">Label</label>
      <input
        type="text"
        value={(config.label as string) || ''}
        onChange={(e) => onChange({ label: e.target.value })}
        placeholder="Optional label"
        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
      />
    </div>
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
        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
      >
        <option value="horizontal">Horizontal</option>
        <option value="vertical">Vertical</option>
        <option value="diagonal-tl">Diagonal (Top-Left to Bottom-Right)</option>
        <option value="diagonal-tr">Diagonal (Top-Right to Bottom-Left)</option>
      </select>
    </div>
    <div>
      <label className="block text-xs text-gray-500 mb-1">Stroke</label>
      <input
        type="color"
        value={(config.stroke as string) || '#1d4ed8'}
        onChange={(e) => onChange({ stroke: e.target.value })}
        className="w-full h-8 rounded-lg border border-gray-300 cursor-pointer"
      />
    </div>
    <div>
      <label className="block text-xs text-gray-500 mb-1">Stroke Width</label>
      <input
        type="number"
        min={1}
        max={20}
        value={(config.strokeWidth as number) ?? 3}
        onChange={(e) => onChange({ strokeWidth: Number(e.target.value) })}
        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
      />
    </div>
    <div>
      <label className="block text-xs text-gray-500 mb-1">Dash Pattern</label>
      <input
        type="text"
        value={(config.dashArray as string) || ''}
        onChange={(e) => onChange({ dashArray: e.target.value })}
        placeholder="e.g. 8 4 (empty = solid)"
        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
      />
      <p className="text-[10px] text-gray-400 mt-0.5">Space-separated dash & gap lengths. Leave empty for solid line.</p>
    </div>
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
        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
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
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Weight</label>
        <select
          value={(config.fontWeight as string) || 'normal'}
          onChange={(e) => onChange({ fontWeight: e.target.value })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
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
      />
    </div>
    <div>
      <label className="block text-xs text-gray-500 mb-1">Alignment</label>
      <select
        value={(config.textAlign as string) || 'center'}
        onChange={(e) => onChange({ textAlign: e.target.value })}
        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
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
  </div>
);
