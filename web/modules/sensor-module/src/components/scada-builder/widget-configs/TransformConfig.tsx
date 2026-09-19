/**
 * Shared transform configuration panel rendered for ALL widget types.
 * Provides rotation, scale, skew, and origin controls that apply
 * CSS transforms at the ScadaWidgetNode container level.
 *
 * Design: Collapsible section that starts collapsed by default --
 * most widgets don't need transforms, so it shouldn't take space.
 */

import React, { useState, useCallback } from 'react';
import { Button } from '@aquaculture/shared-ui';
import type { SvgTransform } from '../../../types/scada-transform.types';
import { DEFAULT_SVG_TRANSFORM, clampTransform } from '../../../types/scada-transform.types';
import { ChevronDown } from 'lucide-react';

interface TransformConfigProps {
  transform: SvgTransform;
  onChange: (updates: Partial<SvgTransform>) => void;
}

/** 3x3 origin grid positions mapping to [originX, originY] ratios */
const ORIGIN_GRID: Array<{ label: string; x: number; y: number }> = [
  { label: 'Top Left', x: 0, y: 0 },
  { label: 'Top Center', x: 0.5, y: 0 },
  { label: 'Top Right', x: 1, y: 0 },
  { label: 'Middle Left', x: 0, y: 0.5 },
  { label: 'Center', x: 0.5, y: 0.5 },
  { label: 'Middle Right', x: 1, y: 0.5 },
  { label: 'Bottom Left', x: 0, y: 1 },
  { label: 'Bottom Center', x: 0.5, y: 1 },
  { label: 'Bottom Right', x: 1, y: 1 },
];

const INPUT_CLASS =
  'w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500 focus:border-info-500';

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
    <div className="border-t border-gray-100 dark:border-gray-700 pt-2">
      <Button
        variant="ghost"
        size="xs"
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label="Transform settings"
      >
        <span>Transform</span>
        <ChevronDown
          className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </Button>

      {open && (
        <div className="space-y-3 mt-2">
          {/* Rotation */}
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
              Rotation (deg)
            </label>
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
              <Button
                variant="secondary"
                size="xs"
                className="shrink-0"
                type="button"
                onClick={() => handleChange({ rotation: 0 })}
                title="Reset rotation"
                aria-label="Reset rotation"
              >
                0
              </Button>
            </div>
          </div>

          {/* Scale */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-gray-500 dark:text-gray-400">Scale</label>
              <button
                type="button"
                onClick={() => setAspectLock(!aspectLock)}
                className={`text-xs px-1.5 py-0.5 rounded ${
                  aspectLock
                    ? 'bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300'
                    : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'
                }`}
                title={aspectLock ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                aria-label={aspectLock ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                aria-pressed={aspectLock}
              >
                {aspectLock ? 'Locked' : 'Lock'}
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-gray-400 dark:text-gray-500 mb-0.5">
                  X
                </label>
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
                <label className="block text-[10px] text-gray-400 dark:text-gray-500 mb-0.5">
                  Y
                </label>
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Skew X</label>
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
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Skew Y</label>
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
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Origin</label>
            <div
              className="inline-grid grid-cols-1 sm:grid-cols-3 gap-1 p-1.5 bg-gray-50 dark:bg-gray-800 rounded-lg"
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
                        ? 'bg-info-500 border-info-600'
                        : 'bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600 hover:border-info-400'
                    }`}
                    data-testid={`origin-${point.label.replace(/\s+/g, '-').toLowerCase()}`}
                  />
                );
              })}
            </div>
          </div>

          {/* Reset all */}
          <Button
            variant="secondary"
            size="xs"
            type="button"
            onClick={handleReset}
            aria-label="Reset all transforms"
            data-testid="transform-reset-all"
          >
            Reset All Transforms
          </Button>
        </div>
      )}
    </div>
  );
};
