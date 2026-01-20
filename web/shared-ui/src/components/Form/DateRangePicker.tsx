/**
 * DateRangePicker Component
 * Select a date range with two calendars
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';

export interface DateRange {
  start: Date | null;
  end: Date | null;
}

export interface DateRangePickerProps {
  value?: DateRange;
  onChange?: (range: DateRange) => void;
  placeholder?: string;
  label?: string;
  error?: string;
  helperText?: string;
  required?: boolean;
  disabled?: boolean;
  minDate?: Date;
  maxDate?: Date;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  presets?: { label: string; getValue: () => DateRange }[];
}

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

const defaultPresets = [
  {
    label: 'Today',
    getValue: () => {
      const today = new Date();
      return { start: today, end: today };
    },
  },
  {
    label: 'Last 7 days',
    getValue: () => {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 6);
      return { start, end };
    },
  },
  {
    label: 'Last 30 days',
    getValue: () => {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 29);
      return { start, end };
    },
  },
  {
    label: 'This month',
    getValue: () => {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return { start, end };
    },
  },
  {
    label: 'Last month',
    getValue: () => {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      return { start, end };
    },
  },
];

export const DateRangePicker: React.FC<DateRangePickerProps> = ({
  value = { start: null, end: null },
  onChange,
  placeholder = 'Select date range',
  label,
  error,
  helperText,
  required = false,
  disabled = false,
  minDate,
  maxDate,
  size = 'md',
  className = '',
  presets = defaultPresets,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [viewDate, setViewDate] = useState(value.start || new Date());
  const [selecting, setSelecting] = useState<'start' | 'end'>('start');
  const [tempRange, setTempRange] = useState<DateRange>(value);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Sync temp range when value changes
  useEffect(() => {
    setTempRange(value);
  }, [value]);

  const formatDate = (date: Date | null): string => {
    if (!date) return '';
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const getDisplayText = (): string => {
    if (!value.start && !value.end) return placeholder;
    if (value.start && value.end) {
      return `${formatDate(value.start)} - ${formatDate(value.end)}`;
    }
    return formatDate(value.start || value.end);
  };

  // Generate calendar for a specific month
  const getCalendarDays = (year: number, month: number) => {
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const days: (Date | null)[] = [];

    for (let i = 0; i < firstDay.getDay(); i++) {
      days.push(null);
    }

    for (let i = 1; i <= lastDay.getDate(); i++) {
      days.push(new Date(year, month, i));
    }

    return days;
  };

  const leftCalendar = useMemo(() => {
    return getCalendarDays(viewDate.getFullYear(), viewDate.getMonth());
  }, [viewDate]);

  const rightCalendar = useMemo(() => {
    const nextMonth = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1);
    return getCalendarDays(nextMonth.getFullYear(), nextMonth.getMonth());
  }, [viewDate]);

  const handlePrevMonth = () => {
    setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1));
  };

  const handleNextMonth = () => {
    setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1));
  };

  const handleDateClick = (date: Date) => {
    if (selecting === 'start') {
      setTempRange({ start: date, end: null });
      setSelecting('end');
    } else {
      if (tempRange.start && date < tempRange.start) {
        setTempRange({ start: date, end: tempRange.start });
      } else {
        setTempRange({ ...tempRange, end: date });
      }
      setSelecting('start');
    }
  };

  const handleApply = () => {
    if (tempRange.start && tempRange.end) {
      onChange?.(tempRange);
      setIsOpen(false);
    }
  };

  const handleCancel = () => {
    setTempRange(value);
    setSelecting('start');
    setIsOpen(false);
  };

  const handlePreset = (preset: typeof presets[0]) => {
    const range = preset.getValue();
    setTempRange(range);
    onChange?.(range);
    setIsOpen(false);
  };

  const isDateDisabled = (date: Date): boolean => {
    if (minDate && date < minDate) return true;
    if (maxDate && date > maxDate) return true;
    return false;
  };

  const isInRange = (date: Date): boolean => {
    if (!tempRange.start || !tempRange.end) return false;
    return date >= tempRange.start && date <= tempRange.end;
  };

  const isStartDate = (date: Date): boolean => {
    if (!tempRange.start) return false;
    return date.toDateString() === tempRange.start.toDateString();
  };

  const isEndDate = (date: Date): boolean => {
    if (!tempRange.end) return false;
    return date.toDateString() === tempRange.end.toDateString();
  };

  const renderCalendar = (days: (Date | null)[], monthOffset: number) => {
    const displayMonth = new Date(viewDate.getFullYear(), viewDate.getMonth() + monthOffset, 1);

    return (
      <div className="w-64">
        <div className="text-center text-sm font-semibold mb-2">
          {MONTHS[displayMonth.getMonth()]} {displayMonth.getFullYear()}
        </div>
        <div className="grid grid-cols-7 gap-1 mb-1">
          {DAYS.map((day) => (
            <div key={day} className="text-center text-xs font-medium text-gray-500 py-1">
              {day}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {days.map((date, index) => {
            if (!date) {
              return <div key={index} className="p-2" />;
            }

            const isDisabled = isDateDisabled(date);
            const inRange = isInRange(date);
            const isStart = isStartDate(date);
            const isEnd = isEndDate(date);

            return (
              <button
                key={index}
                type="button"
                onClick={() => !isDisabled && handleDateClick(date)}
                disabled={isDisabled}
                className={`
                  p-2 text-sm transition-colors
                  ${isStart ? 'bg-blue-600 text-white rounded-l-lg' : ''}
                  ${isEnd ? 'bg-blue-600 text-white rounded-r-lg' : ''}
                  ${inRange && !isStart && !isEnd ? 'bg-blue-100' : ''}
                  ${!inRange && !isStart && !isEnd ? 'hover:bg-gray-100 rounded-lg' : ''}
                  ${isDisabled ? 'text-gray-300 cursor-not-allowed' : 'cursor-pointer'}
                `}
              >
                {date.getDate()}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const sizeClasses = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-sm',
    lg: 'px-4 py-2.5 text-base',
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {label && (
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}

      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`
          w-full flex items-center justify-between rounded-lg border
          bg-white text-left
          focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500
          disabled:bg-gray-100 disabled:cursor-not-allowed
          ${sizeClasses[size]}
          ${error ? 'border-red-500' : 'border-gray-300'}
        `}
      >
        <span className={value.start ? 'text-gray-900' : 'text-gray-400'}>
          {getDisplayText()}
        </span>
        <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute z-50 mt-1 bg-white rounded-lg shadow-lg border border-gray-200 p-4">
          <div className="flex gap-4">
            {/* Presets */}
            <div className="w-32 border-r border-gray-200 pr-4">
              <div className="text-xs font-medium text-gray-500 mb-2">Quick Select</div>
              {presets.map((preset, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => handlePreset(preset)}
                  className="block w-full text-left text-sm text-gray-700 hover:text-blue-600 hover:bg-blue-50 px-2 py-1.5 rounded"
                >
                  {preset.label}
                </button>
              ))}
            </div>

            {/* Calendars */}
            <div className="flex gap-4">
              <div>
                <button
                  type="button"
                  onClick={handlePrevMonth}
                  className="absolute left-40 p-1 hover:bg-gray-100 rounded"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                {renderCalendar(leftCalendar, 0)}
              </div>
              <div>
                <button
                  type="button"
                  onClick={handleNextMonth}
                  className="absolute right-4 p-1 hover:bg-gray-100 rounded"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
                {renderCalendar(rightCalendar, 1)}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-200">
            <div className="text-sm text-gray-500">
              {tempRange.start && !tempRange.end && (
                <span>Select end date</span>
              )}
              {tempRange.start && tempRange.end && (
                <span>
                  {formatDate(tempRange.start)} - {formatDate(tempRange.end)}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleCancel}
                className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleApply}
                disabled={!tempRange.start || !tempRange.end}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-1 text-sm text-red-600" role="alert">{error}</p>
      )}
      {!error && helperText && (
        <p className="mt-1 text-sm text-gray-500">{helperText}</p>
      )}
    </div>
  );
};

export default DateRangePicker;
