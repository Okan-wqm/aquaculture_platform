/**
 * ShiftPalette Component
 * Draggable shift options for the scheduling calendar
 *
 * Keyboard Navigation:
 * - Tab: Navigate between shifts
 * - Enter/Space: Select shift for keyboard-based assignment
 * - Escape: Clear selection
 */

import React, { useCallback } from 'react';
import { Coffee, GripVertical, Check } from 'lucide-react';
import { cn } from '@aquaculture/shared-ui';
import { useShifts } from '../../hooks/useAttendance';
import { useOptionalSchedulingKeyboard } from './SchedulingKeyboardContext';

interface ShiftPaletteProps {
  className?: string;
  compact?: boolean;
}

interface DraggableShiftProps {
  shiftId: string;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  colorCode?: string;
  isOffDay?: boolean;
}

function DraggableShift({
  shiftId,
  code,
  name,
  startTime,
  endTime,
  colorCode = '#3B82F6',
  isOffDay = false,
}: DraggableShiftProps) {
  const keyboardCtx = useOptionalSchedulingKeyboard();

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(
      'application/json',
      JSON.stringify({ shiftId: isOffDay ? null : shiftId, isOffDay })
    );
    e.dataTransfer.effectAllowed = 'copy';
  };

  // Keyboard selection handler
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        keyboardCtx?.selectShift({
          shiftId: isOffDay ? null : shiftId,
          isOffDay,
          shiftName: isOffDay ? 'Tatil' : name,
        });
      }
    },
    [keyboardCtx, shiftId, isOffDay, name]
  );

  const handleClick = useCallback(() => {
    // Also allow click selection when in keyboard mode context
    keyboardCtx?.selectShift({
      shiftId: isOffDay ? null : shiftId,
      isOffDay,
      shiftName: isOffDay ? 'Tatil' : name,
    });
  }, [keyboardCtx, shiftId, isOffDay, name]);

  // Check if this shift is currently selected
  const isSelected =
    keyboardCtx?.selectedShift &&
    keyboardCtx.selectedShift.shiftId === (isOffDay ? null : shiftId) &&
    keyboardCtx.selectedShift.isOffDay === isOffDay;

  if (isOffDay) {
    return (
      <div
        draggable
        onDragStart={handleDragStart}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="button"
        aria-label="Tatil - secmek icin Enter basin"
        aria-pressed={!!isSelected}
        className={cn(
          'flex items-center gap-2 px-3 py-2 rounded-lg cursor-grab',
          'bg-gray-100 border border-gray-200',
          'hover:bg-gray-200 active:cursor-grabbing',
          'transition-colors select-none',
          'focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1',
          isSelected && 'ring-2 ring-indigo-500 bg-gray-200'
        )}
      >
        <GripVertical className="h-4 w-4 text-gray-400 flex-shrink-0" aria-hidden="true" />
        <Coffee className="h-4 w-4 text-gray-600" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-gray-700 truncate">Tatil</div>
          <div className="text-xs text-gray-500">Izin gunu</div>
        </div>
        {isSelected && (
          <Check className="h-4 w-4 text-indigo-600 flex-shrink-0" aria-hidden="true" />
        )}
      </div>
    );
  }

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="button"
      aria-label={`${name} vardiyasi (${startTime}-${endTime}) - secmek icin Enter basin`}
      aria-pressed={!!isSelected}
      className={cn(
        'flex items-center gap-2 px-3 py-2 rounded-lg cursor-grab',
        'border hover:opacity-80 active:cursor-grabbing',
        'transition-colors select-none',
        'focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1',
        isSelected && 'ring-2 ring-indigo-500'
      )}
      style={{
        backgroundColor: `${colorCode}15`,
        borderColor: `${colorCode}40`,
      }}
    >
      <GripVertical className="h-4 w-4 text-gray-400 flex-shrink-0" aria-hidden="true" />
      <div
        className="h-3 w-3 rounded-full flex-shrink-0"
        style={{ backgroundColor: colorCode }}
        aria-hidden="true"
      />
      <div className="flex-1 min-w-0">
        <div
          className="text-sm font-medium truncate"
          style={{ color: colorCode }}
        >
          {code}
        </div>
        <div className="text-xs text-gray-500">
          {startTime} - {endTime}
        </div>
      </div>
      {isSelected && (
        <Check className="h-4 w-4 text-indigo-600 flex-shrink-0" aria-hidden="true" />
      )}
    </div>
  );
}

export function ShiftPalette({ className, compact = false }: ShiftPaletteProps) {
  const { data: shifts, isLoading } = useShifts({ isActive: true });
  const keyboardCtx = useOptionalSchedulingKeyboard();

  if (isLoading) {
    return (
      <div className={cn('space-y-2', className)} role="status" aria-busy="true">
        <span className="sr-only">Vardiyalar yukleniyor...</span>
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-14 bg-gray-100 rounded-lg animate-pulse"
            aria-hidden="true"
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={cn('space-y-2', className)}
      role="toolbar"
      aria-label="Vardiya secimi"
    >
      {!compact && (
        <h4 className="text-sm font-medium text-gray-700 mb-3">
          Vardiyalar
          <span className="text-xs text-gray-400 ml-2">(surukle veya sec)</span>
        </h4>
      )}

      {/* Keyboard instructions for screen readers */}
      <p className="sr-only">
        Vardiya secmek icin Enter veya Space tuslarina basin.
        Secilen vardiyayi iptal etmek icin Escape tusuna basin.
      </p>

      {/* Selection status indicator */}
      {keyboardCtx?.selectedShift && (
        <div
          className="text-xs text-indigo-600 bg-indigo-50 rounded-md px-2 py-1 mb-2"
          role="status"
        >
          <span className="font-medium">
            {keyboardCtx.selectedShift.shiftName || 'Vardiya'}
          </span>{' '}
          secili - takvime gidip Enter basin
        </div>
      )}

      {/* Off Day Option */}
      <DraggableShift
        shiftId=""
        code="OFF"
        name="Tatil"
        startTime="-"
        endTime="-"
        isOffDay
      />

      {/* Active Shifts */}
      {shifts?.map((shift) => (
        <DraggableShift
          key={shift.id}
          shiftId={shift.id}
          code={shift.code}
          name={shift.name}
          startTime={shift.startTime}
          endTime={shift.endTime}
          colorCode={shift.colorCode}
        />
      ))}

      {/* No shifts message */}
      {!shifts?.length && (
        <p className="text-sm text-gray-500 text-center py-4">
          Vardiya bulunamadi. Lutfen once vardiya tanimlayin.
        </p>
      )}
    </div>
  );
}

export default ShiftPalette;
