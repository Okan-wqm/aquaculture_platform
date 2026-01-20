/**
 * DateRangePicker Component
 *
 * Uydu görüntüsü tarihi seçici
 * - Hızlı seçim presetleri
 * - Manuel tarih girişi
 * - Mevcut görüntü tarihleri listesi
 * - Son uydu geçişi bilgisi
 */

import React, { useState, useEffect } from 'react';
import { format, subDays, subMonths, formatDistanceToNow } from 'date-fns';
import { tr } from 'date-fns/locale';

interface DateRangePickerProps {
  selectedDate: Date;
  availableDates: Date[];
  onDateChange: (date: Date) => void;
  isLoading?: boolean;
  lastUpdateInfo?: string;
}

const PRESETS = [
  { label: 'Bugün', days: 0 },
  { label: '7 gün önce', days: 7 },
  { label: '30 gün önce', days: 30 },
  { label: '3 ay önce', months: 3 },
];

export const DateRangePicker: React.FC<DateRangePickerProps> = ({
  selectedDate,
  availableDates,
  onDateChange,
  isLoading = false,
  lastUpdateInfo,
}) => {
  const [isOpen, setIsOpen] = useState(false);

  // Sort available dates (most recent first)
  const sortedDates = [...availableDates].sort((a, b) => b.getTime() - a.getTime());

  // Get last available date
  const lastAvailableDate = sortedDates[0];

  const handlePresetClick = (preset: (typeof PRESETS)[0]) => {
    let date: Date;
    if (preset.months) {
      date = subMonths(new Date(), preset.months);
    } else {
      date = subDays(new Date(), preset.days || 0);
    }
    onDateChange(date);
    setIsOpen(false);
  };

  const handleDateSelect = (date: Date) => {
    onDateChange(date);
    setIsOpen(false);
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.date-picker-container')) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('click', handleClickOutside);
    }

    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div className="absolute bottom-4 left-4 z-[1000] date-picker-container">
      <div className="bg-white rounded-lg shadow-lg overflow-hidden">
        {/* Header */}
        <div className="px-3 py-2 bg-gray-50 border-b">
          <div className="text-xs font-medium text-gray-500">Uydu Görüntüsü Tarihi</div>
        </div>

        {/* Main Button */}
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 transition-colors"
          disabled={isLoading}
        >
          <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
          <span className="text-sm font-medium text-gray-700">
            {format(selectedDate, 'd MMMM yyyy', { locale: tr })}
          </span>
          {isLoading && (
            <svg className="w-4 h-4 animate-spin text-primary-600 ml-auto" viewBox="0 0 24 24">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
          )}
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform ${isLoading ? '' : 'ml-auto'} ${
              isOpen ? 'rotate-180' : ''
            }`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {/* Dropdown */}
        {isOpen && (
          <div className="border-t">
            {/* Quick Presets */}
            <div className="p-2 border-b">
              <div className="text-xs text-gray-500 mb-2 px-1">Hızlı Seçim</div>
              <div className="flex flex-wrap gap-1">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    onClick={() => handlePresetClick(preset)}
                    className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded transition-colors"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Manual Date Input */}
            <div className="p-2 border-b">
              <div className="text-xs text-gray-500 mb-2 px-1">Manuel Tarih</div>
              <input
                type="date"
                value={format(selectedDate, 'yyyy-MM-dd')}
                onChange={(e) => {
                  if (e.target.value) {
                    onDateChange(new Date(e.target.value));
                    setIsOpen(false);
                  }
                }}
                max={format(new Date(), 'yyyy-MM-dd')}
                className="w-full px-2 py-1 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>

            {/* Available Dates */}
            {sortedDates.length > 0 && (
              <div className="p-2">
                <div className="text-xs text-gray-500 mb-2 px-1">
                  Mevcut Görüntüler ({sortedDates.length})
                </div>
                <div className="max-h-40 overflow-y-auto space-y-1">
                  {sortedDates.slice(0, 15).map((date, index) => {
                    const isSelected = format(date, 'yyyy-MM-dd') === format(selectedDate, 'yyyy-MM-dd');
                    const isLatest = index === 0;

                    return (
                      <button
                        key={date.toISOString()}
                        onClick={() => handleDateSelect(date)}
                        className={`w-full text-left px-2 py-1.5 text-xs rounded flex items-center justify-between transition-colors ${
                          isSelected
                            ? 'bg-primary-100 text-primary-700'
                            : 'hover:bg-gray-100 text-gray-700'
                        }`}
                      >
                        <span>{format(date, 'd MMMM yyyy', { locale: tr })}</span>
                        {isLatest && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-green-100 text-green-700 rounded">
                            En Yeni
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Last Update Info */}
        {lastAvailableDate && (
          <div className="px-3 py-2 bg-gray-50 border-t">
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="w-2 h-2 rounded-full bg-green-500"></span>
              <span>Son Uydu Geçişi:</span>
              <span className="font-medium text-gray-700">
                {formatDistanceToNow(lastAvailableDate, { locale: tr, addSuffix: true })}
              </span>
            </div>
          </div>
        )}

        {/* Sentinel-2 Info */}
        <div className="px-3 py-1.5 bg-blue-50 text-[10px] text-blue-600">
          Sentinel-2: Türkiye için ~2-3 günde bir geçiş
        </div>
      </div>
    </div>
  );
};

export default DateRangePicker;
