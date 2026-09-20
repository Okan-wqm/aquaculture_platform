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
import { Checkbox, Input, NumberInput } from '@aquaculture/shared-ui';

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

const LABEL_CLASS =
  'block text-[11px] text-gray-600 dark:text-gray-400 mb-0.5 uppercase tracking-wide';

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
    <div
      className="space-y-3 pb-3 mb-3 border-b border-gray-100 dark:border-gray-700"
      data-testid="general-properties"
    >
      {/* Widget name */}
      <Input
        label="Name"
        id={`widget-name-${widgetId}`}
        value={name}
        onChange={handleNameChange}
        placeholder={typeLabel}
        data-testid="widget-name-input"
      />

      {/* Widget type badge (read-only) */}
      <div>
        <span className={LABEL_CLASS}>Type</span>
        <span
          className="inline-block px-2 py-0.5 text-[10px] font-medium text-info-700 dark:text-info-300 bg-info-50 dark:bg-info-900/20 border border-info-200 dark:border-info-800 rounded capitalize"
          data-testid="widget-type-badge"
        >
          {typeLabel}
        </span>
      </div>

      {/* Position (col / row) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <NumberInput
          label="X (col)"
          id={`widget-x-${widgetId}`}
          min={0}
          step={1}
          value={x}
          onChange={(e) => handlePositionChange('col', Number(e.target.value))}
          data-testid="widget-x-input"
        />
        <NumberInput
          label="Y (row)"
          id={`widget-y-${widgetId}`}
          min={0}
          step={1}
          value={y}
          onChange={(e) => handlePositionChange('row', Number(e.target.value))}
          data-testid="widget-y-input"
        />
      </div>

      {/* Size (w / h) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <NumberInput
          label="W (cols)"
          id={`widget-w-${widgetId}`}
          min={1}
          step={1}
          value={w}
          onChange={(e) => handleSizeChange('w', Number(e.target.value))}
          data-testid="widget-w-input"
        />
        <NumberInput
          label="H (rows)"
          id={`widget-h-${widgetId}`}
          min={1}
          step={1}
          value={h}
          onChange={(e) => handleSizeChange('h', Number(e.target.value))}
          data-testid="widget-h-input"
        />
      </div>

      {/* Locked + Visible toggles in a single row */}
      <div className="flex items-center gap-4">
        <Checkbox
          label="Locked"
          checked={locked}
          onChange={handleLockedChange}
          data-testid="widget-locked-checkbox"
        />
        <Checkbox
          label="Visible"
          checked={visible}
          onChange={handleVisibleChange}
          data-testid="widget-visible-checkbox"
        />
      </div>
    </div>
  );
};

export default GeneralPropertiesSection;
