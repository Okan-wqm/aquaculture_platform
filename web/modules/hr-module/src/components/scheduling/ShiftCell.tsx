/**
 * ShiftCell Component
 * Individual cell in the weekly calendar grid showing shift or off day
 *
 * Keyboard Navigation:
 * - Tab: Navigate to cell
 * - Enter/Space: Apply selected shift from palette (keyboard mode)
 * - Arrow keys: Navigate between cells (handled by parent grid)
 */

import React, { useState, useCallback } from 'react';
import { Coffee, Calendar, GraduationCap, Umbrella } from 'lucide-react';
import { cn } from '@aquaculture/shared-ui';
import type { WeeklyPlanEntry, WeeklyPlanEntryType } from '../../types/scheduling.types';
import { useOptionalSchedulingKeyboard } from './SchedulingKeyboardContext';
// SEC-006: sanitize API-sourced color codes before interpolation into inline styles
import { sanitizeColor } from '../leave/LeaveBalanceWidget';

interface ShiftCellProps {
  entry?: WeeklyPlanEntry;
  isEditable?: boolean;
  isSelected?: boolean;
  onSelect?: () => void;
  onDrop?: (shiftId: string | null, isOffDay: boolean) => void;
  compact?: boolean;
  dayLabel?: string; // For accessibility: "Pazartesi", "Sali", etc.
  dateLabel?: string; // For accessibility: "13 Ocak", etc.
}

const entryTypeConfig: Record<
  WeeklyPlanEntryType,
  { label: string; icon: React.ElementType; bgClass: string; textClass: string }
> = {
  work: { label: 'Mesai', icon: Calendar, bgClass: 'bg-blue-100', textClass: 'text-blue-800' },
  off: { label: 'Tatil', icon: Coffee, bgClass: 'bg-gray-100', textClass: 'text-gray-600' },
  leave: { label: 'Izin', icon: Umbrella, bgClass: 'bg-green-100', textClass: 'text-green-800' },
  holiday: { label: 'Resmi', icon: Calendar, bgClass: 'bg-purple-100', textClass: 'text-purple-800' },
  training: { label: 'Egitim', icon: GraduationCap, bgClass: 'bg-amber-100', textClass: 'text-amber-800' },
};

export function ShiftCell({
  entry,
  isEditable = false,
  isSelected = false,
  onSelect,
  onDrop,
  compact = false,
  dayLabel = '',
  dateLabel = '',
}: ShiftCellProps) {
  const keyboardCtx = useOptionalSchedulingKeyboard();

  // BUG-012: use React state instead of classList mutations to track drag-over
  // so we stay inside the React virtual DOM reconciliation cycle.
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    if (isEditable) {
      e.preventDefault();
      setIsDragOver(true);
    }
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);

    if (!isEditable || !onDrop) return;

    const data = e.dataTransfer.getData('application/json');
    if (data) {
      try {
        const { shiftId, isOffDay } = JSON.parse(data);
        onDrop(shiftId, isOffDay);
      } catch {
        // Invalid data
      }
    }
  };

  // Keyboard handler for applying selected shift
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isEditable || !onDrop) return;

      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();

        // If there's a keyboard-selected shift, apply it
        if (keyboardCtx?.selectedShift) {
          const { shiftId, isOffDay } = keyboardCtx.selectedShift;
          onDrop(shiftId, isOffDay);
          keyboardCtx.announce(
            `${keyboardCtx.selectedShift.shiftName || 'Vardiya'} ${dayLabel} gunune atandi.`
          );
          // Clear selection after applying
          keyboardCtx.clearSelection();
        } else {
          // No shift selected, just select this cell
          onSelect?.();
        }
      }
    },
    [isEditable, onDrop, onSelect, keyboardCtx, dayLabel]
  );

  // Build accessible label
  const getAriaLabel = (): string => {
    const parts: string[] = [];
    if (dayLabel) parts.push(dayLabel);
    if (dateLabel) parts.push(dateLabel);

    if (!entry) {
      parts.push('bos hucre');
    } else if (entry.isOffDay || entry.entryType === 'off') {
      parts.push('Tatil');
    } else if (entry.isLeaveDay || entry.entryType === 'leave') {
      parts.push('Izin');
    } else if (entry.shift) {
      parts.push(`${entry.shift.code} vardiyasi`);
      if (entry.plannedStartTime && entry.plannedEndTime) {
        parts.push(`${entry.plannedStartTime}-${entry.plannedEndTime}`);
      }
    }

    if (isEditable && keyboardCtx?.selectedShift) {
      parts.push('- secili vardiyayi atamak icin Enter basin');
    }

    return parts.join(', ');
  };

  // Common props for keyboard accessibility
  const keyboardProps = isEditable
    ? {
        tabIndex: 0,
        onKeyDown: handleKeyDown,
        role: 'gridcell' as const,
        'aria-label': getAriaLabel(),
      }
    : {
        role: 'gridcell' as const,
        'aria-label': getAriaLabel(),
      };

  // Visual indicator when shift is selected and can be applied
  const hasKeyboardSelection = isEditable && keyboardCtx?.selectedShift;

  // Empty cell (no entry)
  if (!entry) {
    return (
      <div
        {...keyboardProps}
        className={cn(
          'h-full min-h-[48px] border border-dashed border-gray-200 rounded-md',
          'flex items-center justify-center',
          isEditable && 'cursor-pointer hover:bg-gray-50',
          isEditable && 'focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1',
          isSelected && 'ring-2 ring-indigo-500',
          hasKeyboardSelection && 'border-indigo-300 bg-indigo-50/30',
          isDragOver && 'ring-2 ring-indigo-400'
        )}
        onClick={onSelect}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <span className="text-xs text-gray-400" aria-hidden="true">-</span>
      </div>
    );
  }

  const config = entryTypeConfig[entry.entryType];
  const Icon = config.icon;

  // Off day cell
  if (entry.isOffDay || entry.entryType === 'off') {
    return (
      <div
        {...keyboardProps}
        className={cn(
          'h-full min-h-[48px] rounded-md p-1.5',
          config.bgClass,
          isEditable && 'cursor-pointer hover:opacity-80',
          isEditable && 'focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1',
          isSelected && 'ring-2 ring-indigo-500',
          hasKeyboardSelection && 'ring-1 ring-indigo-300',
          isDragOver && 'ring-2 ring-indigo-400'
        )}
        onClick={onSelect}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="flex flex-col items-center justify-center h-full">
          <Coffee className={cn('h-4 w-4', config.textClass)} aria-hidden="true" />
          {!compact && <span className={cn('text-xs mt-0.5', config.textClass)}>Tatil</span>}
        </div>
      </div>
    );
  }

  // Leave day cell
  if (entry.isLeaveDay || entry.entryType === 'leave') {
    return (
      <div
        {...keyboardProps}
        className={cn(
          'h-full min-h-[48px] rounded-md p-1.5',
          entryTypeConfig.leave.bgClass,
          isEditable && 'cursor-pointer hover:opacity-80',
          isEditable && 'focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1',
          isSelected && 'ring-2 ring-indigo-500',
          hasKeyboardSelection && 'ring-1 ring-indigo-300',
          isDragOver && 'ring-2 ring-indigo-400'
        )}
        onClick={onSelect}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="flex flex-col items-center justify-center h-full">
          <Umbrella className={cn('h-4 w-4', entryTypeConfig.leave.textClass)} aria-hidden="true" />
          {!compact && <span className={cn('text-xs mt-0.5', entryTypeConfig.leave.textClass)}>Izin</span>}
        </div>
      </div>
    );
  }

  // Work day with shift
  // SEC-006: sanitize colorCode from the API before using in inline style
  const shift = entry.shift;
  const shiftColor = sanitizeColor(shift?.colorCode, '#3B82F6');

  return (
    <div
      {...keyboardProps}
      className={cn(
        'h-full min-h-[48px] rounded-md p-1.5 transition-all',
        isEditable && 'cursor-pointer hover:opacity-80',
        isEditable && 'focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1',
        isSelected && 'ring-2 ring-indigo-500',
        hasKeyboardSelection && 'ring-1 ring-indigo-300',
        isDragOver && 'ring-2 ring-indigo-400'
      )}
      style={{ backgroundColor: `${shiftColor}20` }}
      onClick={onSelect}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex flex-col h-full">
        {/* Shift code/name */}
        <div
          className="text-xs font-semibold truncate"
          style={{ color: shiftColor }}
        >
          {shift?.code || entry.shiftId?.slice(0, 4)}
        </div>

        {/* Time range */}
        {!compact && (
          <div className="text-[10px] text-gray-600 mt-auto">
            {entry.plannedStartTime || shift?.startTime || '07:00'} -{' '}
            {entry.plannedEndTime || shift?.endTime || '15:00'}
          </div>
        )}

        {/* Minutes indicator */}
        {!compact && entry.plannedMinutes > 0 && (
          <div className="text-[10px] text-gray-500">
            {Math.floor(entry.plannedMinutes / 60)}s
          </div>
        )}
      </div>
    </div>
  );
}

export default ShiftCell;
