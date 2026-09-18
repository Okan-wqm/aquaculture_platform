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
import { DebouncedInput } from './DebouncedInput';

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

const LABEL_CLASS = 'block text-[11px] text-gray-600 mb-0.5 uppercase tracking-wide';

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
      {/* Widget name — debounced (~250ms) so typing does not fire an
          updateWidget (and a history entry) per keystroke */}
      <DebouncedInput
        label="Name"
        value={name}
        onCommit={(v) => onUpdate({ name: v })}
        placeholder={typeLabel}
        inputId={`widget-name-${widgetId}`}
        testId="widget-name-input"
      />

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

      {/* Position (col / row) — debounced */}
      <div className="grid grid-cols-2 gap-2">
        <DebouncedInput
          label="X (col)"
          type="number"
          value={x}
          min={0}
          onCommit={(v) => handlePositionChange('col', Number(v))}
          inputId={`widget-x-${widgetId}`}
          testId="widget-x-input"
        />
        <DebouncedInput
          label="Y (row)"
          type="number"
          value={y}
          min={0}
          onCommit={(v) => handlePositionChange('row', Number(v))}
          inputId={`widget-y-${widgetId}`}
          testId="widget-y-input"
        />
      </div>

      {/* Size (w / h) — debounced */}
      <div className="grid grid-cols-2 gap-2">
        <DebouncedInput
          label="W (cols)"
          type="number"
          value={w}
          min={1}
          onCommit={(v) => handleSizeChange('w', Number(v))}
          inputId={`widget-w-${widgetId}`}
          testId="widget-w-input"
        />
        <DebouncedInput
          label="H (rows)"
          type="number"
          value={h}
          min={1}
          onCommit={(v) => handleSizeChange('h', Number(v))}
          inputId={`widget-h-${widgetId}`}
          testId="widget-h-input"
        />
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
