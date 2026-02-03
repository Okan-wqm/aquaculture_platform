/**
 * WeekNavigator Component
 * Navigation component for selecting weeks
 */

import React, { useMemo } from 'react';
import { ChevronLeft, ChevronRight, Calendar } from 'lucide-react';
import { cn } from '@aquaculture/shared-ui';
import { getWeekMonday, formatDateISO } from '../../hooks/useScheduling';

interface WeekNavigatorProps {
  currentWeekStart: Date;
  onChange: (weekStart: Date) => void;
  className?: string;
}

function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

export function WeekNavigator({
  currentWeekStart,
  onChange,
  className,
}: WeekNavigatorProps) {
  const weekNumber = useMemo(() => getWeekNumber(currentWeekStart), [currentWeekStart]);

  const weekEnd = useMemo(() => {
    const end = new Date(currentWeekStart);
    end.setDate(end.getDate() + 6);
    return end;
  }, [currentWeekStart]);

  const formatRange = useMemo(() => {
    const startStr = currentWeekStart.toLocaleDateString('tr-TR', {
      day: 'numeric',
      month: 'short',
    });
    const endStr = weekEnd.toLocaleDateString('tr-TR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    return `${startStr} - ${endStr}`;
  }, [currentWeekStart, weekEnd]);

  const goToPrevWeek = () => {
    const prev = new Date(currentWeekStart);
    prev.setDate(prev.getDate() - 7);
    onChange(prev);
  };

  const goToNextWeek = () => {
    const next = new Date(currentWeekStart);
    next.setDate(next.getDate() + 7);
    onChange(next);
  };

  const goToThisWeek = () => {
    onChange(getWeekMonday(new Date()));
  };

  const isThisWeek = useMemo(() => {
    const thisMonday = getWeekMonday(new Date());
    return formatDateISO(currentWeekStart) === formatDateISO(thisMonday);
  }, [currentWeekStart]);

  return (
    <nav className={cn('flex items-center gap-2', className)} aria-label="Hafta gezinme">
      <button
        onClick={goToPrevWeek}
        className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
        aria-label="Onceki hafta"
      >
        <ChevronLeft className="h-5 w-5 text-gray-600" aria-hidden="true" />
      </button>

      <div
        className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg min-w-[280px]"
        aria-live="polite"
        aria-atomic="true"
      >
        <Calendar className="h-4 w-4 text-indigo-600" aria-hidden="true" />
        <div className="flex flex-col">
          <span className="text-sm font-semibold text-gray-900">
            Hafta {weekNumber}
          </span>
          <span className="text-xs text-gray-500">{formatRange}</span>
        </div>
      </div>

      <button
        onClick={goToNextWeek}
        className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
        aria-label="Sonraki hafta"
      >
        <ChevronRight className="h-5 w-5 text-gray-600" aria-hidden="true" />
      </button>

      {!isThisWeek && (
        <button
          onClick={goToThisWeek}
          className="ml-2 px-3 py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
          aria-label="Bu haftaya don"
        >
          Bugune don
        </button>
      )}
    </nav>
  );
}

export default WeekNavigator;
