/**
 * Shared stroke configuration panel for SVG shape widgets.
 * Provides dash pattern, line cap, line join, stroke width,
 * stroke color, and stroke opacity controls.
 *
 * Each dash pattern option shows a visual SVG preview line
 * so users can see what each pattern looks like.
 */

import React from 'react';
import type { StrokeDashPattern, StrokeLineCap, StrokeLineJoin } from '../../../types/scada-svg-properties.types';
import {
  DASH_PATTERN_MAP,
  DASH_PATTERN_OPTIONS,
  LINE_CAP_OPTIONS,
  LINE_JOIN_OPTIONS,
} from '../../../types/scada-svg-properties.types';

interface StrokeConfigProps {
  stroke: string;
  strokeWidth: number;
  strokeOpacity: number;
  dashPattern: StrokeDashPattern;
  lineCap: StrokeLineCap;
  lineJoin: StrokeLineJoin;
  onChange: (updates: Record<string, string | number>) => void;
}

const INPUT_CLASS =
  'w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500';

/** Small SVG line preview for a given dash pattern */
const DashPreview: React.FC<{ pattern: StrokeDashPattern }> = ({ pattern }) => (
  <svg width="50" height="8" className="inline-block align-middle ml-1" aria-hidden="true">
    <line
      x1="2"
      y1="4"
      x2="48"
      y2="4"
      stroke="currentColor"
      strokeWidth="2"
      strokeDasharray={DASH_PATTERN_MAP[pattern]}
      strokeLinecap="round"
    />
  </svg>
);

/** SVG icon preview for line cap styles */
const LineCapPreview: React.FC<{ cap: StrokeLineCap }> = ({ cap }) => (
  <svg width="32" height="20" viewBox="0 0 32 20" className="block mx-auto" aria-hidden="true">
    <line
      x1="4"
      y1="10"
      x2="28"
      y2="10"
      stroke="currentColor"
      strokeWidth="6"
      strokeLinecap={cap}
    />
  </svg>
);

/** SVG icon preview for line join styles */
const LineJoinPreview: React.FC<{ join: StrokeLineJoin }> = ({ join }) => (
  <svg width="32" height="20" viewBox="0 0 32 20" className="block mx-auto" aria-hidden="true">
    <polyline
      points="4,16 16,4 28,16"
      fill="none"
      stroke="currentColor"
      strokeWidth="4"
      strokeLinejoin={join}
    />
  </svg>
);

/** Human-readable label for dash patterns */
const DASH_LABELS: Record<StrokeDashPattern, string> = {
  solid: 'Solid',
  dotted: 'Dotted',
  dashed: 'Dashed',
  dashDot: 'Dash-Dot',
  dashDotDot: 'Dash-Dot-Dot',
};

export const StrokeConfig: React.FC<StrokeConfigProps> = ({
  stroke,
  strokeWidth,
  strokeOpacity,
  dashPattern,
  lineCap,
  lineJoin,
  onChange,
}) => (
  <div className="space-y-3">
    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Stroke</div>

    {/* Color + hex input */}
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Color</label>
        <input
          type="color"
          value={stroke}
          onChange={(e) => onChange({ stroke: e.target.value })}
          className="w-full h-8 rounded-lg border border-gray-300 cursor-pointer"
          aria-label="Stroke color"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Hex</label>
        <input
          type="text"
          value={stroke}
          onChange={(e) => {
            // Accept valid hex color strings only
            const v = e.target.value;
            if (/^#[0-9a-fA-F]{0,6}$/.test(v)) {
              onChange({ stroke: v });
            }
          }}
          maxLength={7}
          placeholder="#000000"
          className={INPUT_CLASS}
          aria-label="Stroke hex color"
        />
      </div>
    </div>

    {/* Width */}
    <div>
      <label className="block text-xs text-gray-500 mb-1">Width</label>
      <input
        type="number"
        min={0}
        max={20}
        step={0.5}
        value={strokeWidth}
        onChange={(e) => onChange({ strokeWidth: Number(e.target.value) })}
        className={INPUT_CLASS}
        aria-label="Stroke width"
      />
    </div>

    {/* Opacity */}
    <div>
      <label className="block text-xs text-gray-500 mb-1">Opacity</label>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={strokeOpacity}
        onChange={(e) => onChange({ strokeOpacity: Number(e.target.value) })}
        className="w-full"
        aria-label="Stroke opacity"
      />
      <div className="text-xs text-gray-400 text-right">
        {Math.round(strokeOpacity * 100)}%
      </div>
    </div>

    {/* Dash pattern */}
    <div>
      <label className="block text-xs text-gray-500 mb-1">Dash Pattern</label>
      <select
        value={dashPattern}
        onChange={(e) => onChange({ dashPattern: e.target.value })}
        className={INPUT_CLASS}
        aria-label="Dash pattern"
        data-testid="dash-pattern-select"
      >
        {DASH_PATTERN_OPTIONS.map((p) => (
          <option key={p} value={p}>
            {DASH_LABELS[p]}
          </option>
        ))}
      </select>
      {/* Visual preview of currently selected pattern */}
      <div className="mt-1 text-gray-500">
        <DashPreview pattern={dashPattern} />
      </div>
    </div>

    {/* Line cap */}
    <div>
      <label className="block text-xs text-gray-500 mb-1">Line Cap</label>
      <div className="flex gap-2" role="radiogroup" aria-label="Line cap style">
        {LINE_CAP_OPTIONS.map((cap) => (
          <label
            key={cap}
            className={`flex-1 flex flex-col items-center p-1.5 rounded-lg border-2 cursor-pointer transition-colors ${
              lineCap === cap
                ? 'border-cyan-500 bg-cyan-50'
                : 'border-gray-200 hover:border-gray-300'
            }`}
          >
            <input
              type="radio"
              name="lineCap"
              value={cap}
              checked={lineCap === cap}
              onChange={(e) => onChange({ lineCap: e.target.value })}
              className="sr-only"
            />
            <LineCapPreview cap={cap} />
            <span className="text-[10px] text-gray-500 mt-0.5 capitalize">{cap}</span>
          </label>
        ))}
      </div>
    </div>

    {/* Line join */}
    <div>
      <label className="block text-xs text-gray-500 mb-1">Line Join</label>
      <div className="flex gap-2" role="radiogroup" aria-label="Line join style">
        {LINE_JOIN_OPTIONS.map((join) => (
          <label
            key={join}
            className={`flex-1 flex flex-col items-center p-1.5 rounded-lg border-2 cursor-pointer transition-colors ${
              lineJoin === join
                ? 'border-cyan-500 bg-cyan-50'
                : 'border-gray-200 hover:border-gray-300'
            }`}
          >
            <input
              type="radio"
              name="lineJoin"
              value={join}
              checked={lineJoin === join}
              onChange={(e) => onChange({ lineJoin: e.target.value })}
              className="sr-only"
            />
            <LineJoinPreview join={join} />
            <span className="text-[10px] text-gray-500 mt-0.5 capitalize">{join}</span>
          </label>
        ))}
      </div>
    </div>
  </div>
);
