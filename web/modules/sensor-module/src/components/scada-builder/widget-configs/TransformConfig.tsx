/**
 * Shared transform configuration panel rendered for ALL widget types.
 * Provides rotation, scale, skew, and origin controls that apply
 * CSS transforms at the ScadaWidgetNode container level.
 *
 * Design: Collapsible section that starts collapsed by default --
 * most widgets don't need transforms, so it shouldn't take space.
 */

import React, { useState, useCallback } from 'react';
import type { SvgTransform } from '../../../types/scada-transform.types';
import { DEFAULT_SVG_TRANSFORM, clampTransform } from '../../../types/scada-transform.types';

interface TransformConfigProps {
  transform: SvgTransform;
  onChange: (updates: Partial<SvgTransform>) => void;
}

/** 3x3 origin grid positions mapping to [originX, originY] ratios */
const ORIGIN_GRID: Array<{ label: string; x: number; y: number }> = [
  { label: 'Top Left',     x: 0,   y: 0   },
  { label: 'Top Center',   x: 0.5, y: 0   },
  { label: 'Top Right',    x: 1,   y: 0   },
  { label: 'Middle Left',  x: 0,   y: 0.5 },
  { label: 'Center',       x: 0.5, y: 0.5 },
  { label: 'Middle Right', x: 1,   y: 0.5 },
  { label: 'Bottom Left',  x: 0,   y: 1   },
  { label: 'Bottom Center',x: 0.5, y: 1   },
  { label: 'Bottom Right', x: 1,   y: 1   },
];

const INPUT_CLASS =
  'w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500';

export const TransformConfig: React.FC<TransformConfigProps> = ({ transform, onChange }) => {
  const [open, setOpen] = useState(false);
  const [aspectLock, setAspectLock] = useState(false);

  const handleChange = useCallback(
    (updates: Partial<SvgTransform>) => {
      onChange(clampTransform(updates) as Partial<SvgTransform>);
    },
    [onChange],
  );

  /** When aspect lock is active, changing one scale axis applies to both */
  const handleScaleChange = useCallback(
    (axis: 'scaleX' | 'scaleY', value: number) => {
      if (aspectLock) {
        handleChange({ scaleX: value, scaleY: value });
      } else {
        handleChange({ [axis]: value });
      }
    },
    [aspectLock, handleChange],
  );

  const handleReset = useCallback(() => {
    onChange({ ...DEFAULT_SVG_TRANSFORM });
  }, [onChange]);

  return (
    <div className="border-t border-gray-100 pt-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full text-xs font-semibold text-gray-500 uppercase tracking-wide hover:text-gray-700"
        aria-expanded={open}
        aria-label="Transform settings"
      >
        <span>Transform</span>
        <svg
          className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="space-y-3 mt-2">
          {/* Rotation */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Rotation (deg)</label>
            <div className="flex gap-1">
              <input
                type="number"
                min={0}
                max={360}
                step={1}
                value={transform.rotation}
                onChange={(e) => handleChange({ rotation: Number(e.target.value) })}
                onKeyDown={(e) => {
                  // 15-degree snap when shift is held
                  if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                    e.preventDefault();
                    const delta = e.key === 'ArrowUp' ? 15 : -15;
                    handleChange({ rotation: transform.rotation + delta });
                  }
                }}
                className={INPUT_CLASS}
                aria-label="Rotation degrees"
              />
              <button
                type="button"
                onClick={() => handleChange({ rotation: 0 })}
                className="px-2 py-1 text-xs text-gray-400 hover:text-gray-600 border border-gray-300 rounded-lg shrink-0"
                title="Reset rotation"
                aria-label="Reset rotation"
              >
                0
              </button>
            </div>
          </div>

          {/* Scale */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-gray-500">Scale</label>
              <button
                type="button"
                onClick={() => setAspectLock(!aspectLock)}
                className={`text-xs px-1.5 py-0.5 rounded ${
                  aspectLock
                    ? 'bg-cyan-100 text-cyan-700'
                    : 'text-gray-400 hover:text-gray-600'
                }`}
                title={aspectLock ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                aria-label={aspectLock ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                aria-pressed={aspectLock}
              >
                {aspectLock ? 'Locked' : 'Lock'}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-gray-400 mb-0.5">X</label>
                <input
                  type="number"
                  min={0.1}
                  max={10}
                  step={0.1}
                  value={transform.scaleX}
                  onChange={(e) => handleScaleChange('scaleX', Number(e.target.value))}
                  className={INPUT_CLASS}
                  aria-label="Scale X"
                />
              </div>
              <div>
                <label className="block text-[10px] text-gray-400 mb-0.5">Y</label>
                <input
                  type="number"
                  min={0.1}
                  max={10}
                  step={0.1}
                  value={transform.scaleY}
                  onChange={(e) => handleScaleChange('scaleY', Number(e.target.value))}
                  className={INPUT_CLASS}
                  aria-label="Scale Y"
                />
              </div>
            </div>
          </div>

          {/* Skew */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Skew X</label>
              <input
                type="number"
                min={-89}
                max={89}
                step={1}
                value={transform.skewX}
                onChange={(e) => handleChange({ skewX: Number(e.target.value) })}
                className={INPUT_CLASS}
                aria-label="Skew X"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Skew Y</label>
              <input
                type="number"
                min={-89}
                max={89}
                step={1}
                value={transform.skewY}
                onChange={(e) => handleChange({ skewY: Number(e.target.value) })}
                className={INPUT_CLASS}
                aria-label="Skew Y"
              />
            </div>
          </div>

          {/* Origin 3x3 grid */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Origin</label>
            <div
              className="inline-grid grid-cols-3 gap-1 p-1.5 bg-gray-50 rounded-lg"
              role="radiogroup"
              aria-label="Transform origin"
            >
              {ORIGIN_GRID.map((point) => {
                const isActive = transform.originX === point.x && transform.originY === point.y;
                return (
                  <button
                    key={point.label}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    aria-label={point.label}
                    onClick={() => handleChange({ originX: point.x, originY: point.y })}
                    className={`w-5 h-5 rounded-full border-2 transition-colors ${
                      isActive
                        ? 'bg-cyan-500 border-cyan-600'
                        : 'bg-white border-gray-300 hover:border-cyan-400'
                    }`}
                    data-testid={`origin-${point.label.replace(/\s+/g, '-').toLowerCase()}`}
                  />
                );
              })}
            </div>
          </div>

          {/* Reset all */}
          <button
            type="button"
            onClick={handleReset}
            className="w-full py-1.5 text-xs text-gray-500 hover:text-red-500 border border-gray-200 hover:border-red-200 rounded-lg transition-colors"
            aria-label="Reset all transforms"
            data-testid="transform-reset-all"
          >
            Reset All Transforms
          </button>
        </div>
      )}
    </div>
  );
};
