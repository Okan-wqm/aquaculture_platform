/**
 * General properties section rendered at the TOP of every widget's config panel.
 * Shows widget identity (name, type) and spatial properties (position, size)
 * that are common to all widget types regardless of their specific config.
 *
 * This section is NOT part of the per-widget config -- it reads/writes
 * top-level ScreenWidget fields (name, x, y, w, h, locked, visible).
 * The position/size inputs use grid units (columns/rows), not pixels.
 */

import React, { useCallback } from 'react';
import type { ScreenWidget } from '../../../types/scada-package.types';

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface GeneralPropertiesSectionProps {
  widgetId: string;
  widgetType: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  locked: boolean;
  visible: boolean;
  onUpdate: (updates: Partial<ScreenWidget>) => void;
}

/* ------------------------------------------------------------------ */
/*  Shared styles                                                      */
/* ------------------------------------------------------------------ */

const INPUT_CLASS =
  'w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500';

const LABEL_CLASS = 'block text-[10px] text-gray-400 mb-0.5 uppercase tracking-wide';

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const GeneralPropertiesSection: React.FC<GeneralPropertiesSectionProps> = ({
  widgetId,
  widgetType,
  name,
  x,
  y,
  w,
  h,
  locked,
  visible,
  onUpdate,
}) => {
  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onUpdate({ name: e.target.value });
    },
    [onUpdate],
  );

  const handlePositionChange = useCallback(
    (field: 'col' | 'row', value: number) => {
      // Position updates go via the position sub-object so we
      // reconstruct it with current w/h to keep atomic updates.
      onUpdate({
        position: {
          col: field === 'col' ? value : x,
          row: field === 'row' ? value : y,
          w,
          h,
        },
      });
    },
    [onUpdate, x, y, w, h],
  );

  const handleSizeChange = useCallback(
    (field: 'w' | 'h', value: number) => {
      const clamped = Math.max(1, value);
      onUpdate({
        position: {
          col: x,
          row: y,
          w: field === 'w' ? clamped : w,
          h: field === 'h' ? clamped : h,
        },
      });
    },
    [onUpdate, x, y, w, h],
  );

  const handleLockedChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onUpdate({ locked: e.target.checked });
    },
    [onUpdate],
  );

  const handleVisibleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onUpdate({ visible: e.target.checked });
    },
    [onUpdate],
  );

  /** Human-friendly label derived from the camelCase widget type string */
  const typeLabel = widgetType.replace(/([A-Z])/g, ' $1').trim();

  return (
    <div className="space-y-3 pb-3 mb-3 border-b border-gray-100" data-testid="general-properties">
      {/* Widget name */}
      <div>
        <label htmlFor={`widget-name-${widgetId}`} className={LABEL_CLASS}>
          Name
        </label>
        <input
          id={`widget-name-${widgetId}`}
          type="text"
          value={name}
          onChange={handleNameChange}
          placeholder={typeLabel}
          className={INPUT_CLASS}
          data-testid="widget-name-input"
        />
      </div>

      {/* Widget type badge (read-only) */}
      <div>
        <span className={LABEL_CLASS}>Type</span>
        <span
          className="inline-block px-2 py-0.5 text-[10px] font-medium text-cyan-700 bg-cyan-50 border border-cyan-200 rounded capitalize"
          data-testid="widget-type-badge"
        >
          {typeLabel}
        </span>
      </div>

      {/* Position (col / row) */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={`widget-x-${widgetId}`} className={LABEL_CLASS}>
            X (col)
          </label>
          <input
            id={`widget-x-${widgetId}`}
            type="number"
            min={0}
            step={1}
            value={x}
            onChange={(e) => handlePositionChange('col', Number(e.target.value))}
            className={INPUT_CLASS}
            data-testid="widget-x-input"
          />
        </div>
        <div>
          <label htmlFor={`widget-y-${widgetId}`} className={LABEL_CLASS}>
            Y (row)
          </label>
          <input
            id={`widget-y-${widgetId}`}
            type="number"
            min={0}
            step={1}
            value={y}
            onChange={(e) => handlePositionChange('row', Number(e.target.value))}
            className={INPUT_CLASS}
            data-testid="widget-y-input"
          />
        </div>
      </div>

      {/* Size (w / h) */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={`widget-w-${widgetId}`} className={LABEL_CLASS}>
            W (cols)
          </label>
          <input
            id={`widget-w-${widgetId}`}
            type="number"
            min={1}
            step={1}
            value={w}
            onChange={(e) => handleSizeChange('w', Number(e.target.value))}
            className={INPUT_CLASS}
            data-testid="widget-w-input"
          />
        </div>
        <div>
          <label htmlFor={`widget-h-${widgetId}`} className={LABEL_CLASS}>
            H (rows)
          </label>
          <input
            id={`widget-h-${widgetId}`}
            type="number"
            min={1}
            step={1}
            value={h}
            onChange={(e) => handleSizeChange('h', Number(e.target.value))}
            className={INPUT_CLASS}
            data-testid="widget-h-input"
          />
        </div>
      </div>

      {/* Locked + Visible toggles in a single row */}
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={locked}
            onChange={handleLockedChange}
            className="text-cyan-600 rounded focus:ring-cyan-500"
            data-testid="widget-locked-checkbox"
          />
          <span className="text-xs text-gray-600">Locked</span>
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={visible}
            onChange={handleVisibleChange}
            className="text-cyan-600 rounded focus:ring-cyan-500"
            data-testid="widget-visible-checkbox"
          />
          <span className="text-xs text-gray-600">Visible</span>
        </label>
      </div>
    </div>
  );
};

export default GeneralPropertiesSection;
