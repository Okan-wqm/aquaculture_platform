/**
 * SVG filter effects editor for visual enhancements.
 * Supports blur, drop-shadow, and glow effects via SVG filter elements.
 *
 * Architecture: Filters are rendered as <filter> definitions in per-widget
 * <defs> blocks and referenced via the filter="url(#...)" attribute.
 * We use SVG filters (not CSS filters) for cross-browser SVG compatibility --
 * CSS filter property does not reliably work inside <svg> elements.
 *
 * Filter types:
 * - blur: Simple Gaussian blur via <feGaussianBlur>
 * - dropShadow: Offset shadow via <feDropShadow> (composed from primitives)
 * - glow: Outer glow achieved by blurred offset-free shadow in a bright color
 */

import React, { useState, useCallback } from 'react';
import type { SvgFilterConfig, SvgFilterType } from '../../../types/scada-svg-properties.types';
import { SVG_FILTER_TYPE_OPTIONS } from '../../../types/scada-svg-properties.types';
import { ColorAlphaInput } from './ColorAlphaInput';
import { Button, colors, NumberInput, Slider } from '@aquaculture/shared-ui';

/* ------------------------------------------------------------------ */
/*  Props                                                               */
/* ------------------------------------------------------------------ */

interface SvgFilterEditorProps {
  filter: SvgFilterConfig;
  onChange: (filter: SvgFilterConfig) => void;
  widgetId: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const INPUT_CLASS =
  'w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500 focus:border-info-500';

/** Human-readable labels for filter types */
const FILTER_LABELS: Record<SvgFilterType, string> = {
  none: 'None',
  blur: 'Blur',
  dropShadow: 'Drop Shadow',
  glow: 'Glow',
};

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

export const SvgFilterEditor: React.FC<SvgFilterEditorProps> = ({ filter, onChange }) => {
  const [open, setOpen] = useState(filter.type !== 'none');

  const handleTypeChange = useCallback(
    (type: SvgFilterType) => {
      // When switching type, provide sensible defaults for the new filter
      switch (type) {
        case 'blur':
          onChange({ type, blurRadius: filter.blurRadius ?? 4 });
          break;
        case 'dropShadow':
          onChange({
            type,
            blurRadius: filter.blurRadius ?? 4,
            shadowX: filter.shadowX ?? 2,
            shadowY: filter.shadowY ?? 2,
            shadowColor: filter.shadowColor ?? colors.black,
            shadowOpacity: filter.shadowOpacity ?? 0.5,
          });
          break;
        case 'glow':
          onChange({
            type,
            blurRadius: filter.blurRadius ?? 6,
            shadowColor: filter.shadowColor ?? colors.info[500],
            shadowOpacity: filter.shadowOpacity ?? 0.8,
          });
          break;
        default:
          onChange({ type: 'none' });
      }
    },
    [filter, onChange],
  );

  const handleBlurRadius = useCallback(
    (value: number) => {
      onChange({ ...filter, blurRadius: Math.max(0, Math.min(20, value)) });
    },
    [filter, onChange],
  );

  const handleShadowX = useCallback(
    (value: number) => {
      onChange({ ...filter, shadowX: Math.max(-20, Math.min(20, value)) });
    },
    [filter, onChange],
  );

  const handleShadowY = useCallback(
    (value: number) => {
      onChange({ ...filter, shadowY: Math.max(-20, Math.min(20, value)) });
    },
    [filter, onChange],
  );

  const handleShadowColor = useCallback(
    (color: string, opacity: number) => {
      onChange({ ...filter, shadowColor: color, shadowOpacity: opacity });
    },
    [filter, onChange],
  );

  return (
    <div className="border-t border-gray-100 dark:border-gray-700 pt-2">
      <Button
        variant="ghost"
        size="xs"
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label="Filter settings"
      >
        <span>Filter</span>
        <svg
          className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </Button>

      {open && (
        <div className="space-y-3 mt-2">
          {/* Filter type selector */}
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Effect</label>
            <select
              value={filter.type}
              onChange={(e) => handleTypeChange(e.target.value as SvgFilterType)}
              className={INPUT_CLASS}
              aria-label="Filter type"
              data-testid="filter-type-select"
            >
              {SVG_FILTER_TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {FILTER_LABELS[t]}
                </option>
              ))}
            </select>
          </div>

          {/* Blur controls */}
          {filter.type === 'blur' && (
            <div>
              <Slider
                size="xs"
                label="Blur Radius"
                readout="beside-label"
                unit="px"
                min={0}
                max={20}
                step={0.5}
                value={filter.blurRadius ?? 4}
                onChange={handleBlurRadius}
                data-testid="blur-radius"
              />
            </div>
          )}

          {/* Drop shadow controls */}
          {filter.type === 'dropShadow' && (
            <>
              <div>
                <Slider
                  size="xs"
                  label="Blur"
                  readout="beside-label"
                  unit="px"
                  min={0}
                  max={20}
                  step={0.5}
                  value={filter.blurRadius ?? 4}
                  onChange={handleBlurRadius}
                  data-testid="shadow-blur-radius"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <NumberInput
                  label="Offset X"
                  min={-20}
                  max={20}
                  step={1}
                  value={filter.shadowX ?? 2}
                  onChange={(e) => handleShadowX(Number(e.target.value))}
                  aria-label="Shadow offset X"
                  data-testid="shadow-x"
                />
                <NumberInput
                  label="Offset Y"
                  min={-20}
                  max={20}
                  step={1}
                  value={filter.shadowY ?? 2}
                  onChange={(e) => handleShadowY(Number(e.target.value))}
                  aria-label="Shadow offset Y"
                  data-testid="shadow-y"
                />
              </div>
              <ColorAlphaInput
                color={filter.shadowColor ?? colors.black}
                alpha={filter.shadowOpacity ?? 0.5}
                onChange={handleShadowColor}
                label="Shadow Color"
              />
            </>
          )}

          {/* Glow controls */}
          {filter.type === 'glow' && (
            <>
              <div>
                <Slider
                  size="xs"
                  label="Intensity"
                  readout="beside-label"
                  unit="px"
                  min={0}
                  max={20}
                  step={0.5}
                  value={filter.blurRadius ?? 6}
                  onChange={handleBlurRadius}
                  data-testid="glow-intensity"
                />
              </div>
              <ColorAlphaInput
                color={filter.shadowColor ?? colors.info[500]}
                alpha={filter.shadowOpacity ?? 0.8}
                onChange={handleShadowColor}
                label="Glow Color"
              />
            </>
          )}
        </div>
      )}
    </div>
  );
};
