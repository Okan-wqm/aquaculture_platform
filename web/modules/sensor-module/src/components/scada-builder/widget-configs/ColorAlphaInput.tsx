/**
 * Combined color + alpha channel input for per-color opacity control.
 * Replaces separate color picker + opacity slider with a single compact
 * component that outputs a color string and alpha value independently.
 *
 * Used anywhere a color with transparency is needed -- fill, stroke,
 * gradient stops, shadow colors. Keeping color and alpha separate (rather
 * than merging into rgba) simplifies SVG attribute mapping where fill-opacity
 * and stop-opacity are distinct attributes from the color itself.
 */

import React, { useCallback } from 'react';

/* ------------------------------------------------------------------ */
/*  Props                                                               */
/* ------------------------------------------------------------------ */

interface ColorAlphaInputProps {
  /** CSS color string (hex format, e.g. #3b82f6) */
  color: string;
  /** Alpha channel value (0 to 1) */
  alpha: number;
  /** Called when either color or alpha changes */
  onChange: (color: string, alpha: number) => void;
  /** Optional label displayed above the input row */
  label?: string;
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

export const ColorAlphaInput: React.FC<ColorAlphaInputProps> = ({
  color,
  alpha,
  onChange,
  label,
}) => {
  const handleColorChange = useCallback(
    (newColor: string) => {
      onChange(newColor, alpha);
    },
    [alpha, onChange],
  );

  const handleHexInput = useCallback(
    (value: string) => {
      // Accept partial hex input during typing, only propagate valid hex
      if (/^#[0-9a-fA-F]{0,6}$/.test(value)) {
        onChange(value, alpha);
      }
    },
    [alpha, onChange],
  );

  const handleAlphaSlider = useCallback(
    (value: number) => {
      onChange(color, Math.max(0, Math.min(1, value)));
    },
    [color, onChange],
  );

  const handleAlphaText = useCallback(
    (value: string) => {
      const parsed = parseInt(value, 10);
      if (!isNaN(parsed)) {
        onChange(color, Math.max(0, Math.min(1, parsed / 100)));
      }
    },
    [color, onChange],
  );

  const alphaPercent = Math.round(alpha * 100);

  return (
    <div>
      {label && (
        <label className="block text-xs text-gray-500 mb-1">{label}</label>
      )}
      <div className="flex items-center gap-1.5">
        {/* Color swatch -- opens native color picker */}
        <input
          type="color"
          value={color.length === 7 ? color : '#000000'}
          onChange={(e) => handleColorChange(e.target.value)}
          className="w-8 h-8 rounded border border-gray-300 cursor-pointer flex-shrink-0 p-0"
          aria-label={label ? `${label} color swatch` : 'Color swatch'}
          data-testid="color-swatch"
        />

        {/* Hex text input */}
        <input
          type="text"
          value={color}
          onChange={(e) => handleHexInput(e.target.value)}
          maxLength={7}
          placeholder="#000000"
          className="w-20 px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 font-mono"
          aria-label={label ? `${label} hex value` : 'Hex color value'}
          data-testid="color-hex-input"
        />

        {/* Alpha slider */}
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={alpha}
          onChange={(e) => handleAlphaSlider(Number(e.target.value))}
          className="flex-1 min-w-[40px]"
          aria-label={label ? `${label} opacity` : 'Color opacity'}
          data-testid="alpha-slider"
        />

        {/* Alpha percentage text input */}
        <input
          type="number"
          min={0}
          max={100}
          step={1}
          value={alphaPercent}
          onChange={(e) => handleAlphaText(e.target.value)}
          className="w-12 px-1.5 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 text-center"
          aria-label={label ? `${label} opacity percent` : 'Opacity percent'}
          data-testid="alpha-percent"
        />
        <span className="text-[10px] text-gray-400">%</span>
      </div>
    </div>
  );
};
