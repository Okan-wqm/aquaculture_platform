/**
 * MultiSelect Bileşeni
 * Çoklu seçim için checkbox dropdown bileşeni
 * Seçilen değerleri chip olarak gösterir
 */

import React, { forwardRef, useState, useRef, useEffect, useId } from 'react';
import type { Size } from '../../types';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

export interface MultiSelectOption {
  /** Seçenek değeri */
  value: string;
  /** Görüntülenen etiket */
  label: string;
  /** Devre dışı mı */
  disabled?: boolean;
}

export interface MultiSelectProps {
  /** Select etiketi */
  label?: string;
  /** Seçenek listesi */
  options: MultiSelectOption[];
  /** Seçili değerler */
  value: string[];
  /** Değer değiştiğinde çağrılır */
  onChange: (value: string[]) => void;
  /** Hata mesajı */
  error?: string;
  /** Yardım metni */
  helperText?: string;
  /** Select boyutu */
  size?: Size;
  /** Placeholder metni */
  placeholder?: string;
  /** Tam genişlik */
  fullWidth?: boolean;
  /** Zorunlu alan göstergesi */
  required?: boolean;
  /** Devre dışı */
  disabled?: boolean;
  /** Ek sınıf */
  className?: string;
  /** ID */
  id?: string;
}

// ============================================================================
// Stil Sınıfları
// ============================================================================

const sizeStyles: Record<Size, string> = {
  xs: 'px-2 py-1 text-xs min-h-[26px]',
  sm: 'px-3 py-1.5 text-sm min-h-[32px]',
  md: 'px-3 py-2 text-sm min-h-[38px]',
  lg: 'px-4 py-2.5 text-base min-h-[44px]',
  xl: 'px-4 py-3 text-lg min-h-[50px]',
};

const chipSizeStyles: Record<Size, string> = {
  xs: 'text-xs px-1.5 py-0.5',
  sm: 'text-xs px-2 py-0.5',
  md: 'text-sm px-2 py-1',
  lg: 'text-sm px-2.5 py-1',
  xl: 'text-base px-3 py-1',
};

// ============================================================================
// MultiSelect Bileşeni
// ============================================================================

/**
 * MultiSelect bileşeni
 *
 * @example
 * <MultiSelect
 *   label="Parametreler"
 *   options={[
 *     { value: 'temperature', label: 'Sıcaklık' },
 *     { value: 'ph', label: 'pH' },
 *     { value: 'do', label: 'Çözünmüş Oksijen' },
 *   ]}
 *   value={selectedParams}
 *   onChange={setSelectedParams}
 * />
 */
export const MultiSelect = forwardRef<HTMLDivElement, MultiSelectProps>(
  (
    {
      label,
      options,
      value = [],
      onChange,
      error,
      helperText,
      size = 'md',
      placeholder = 'Select...',
      fullWidth = true,
      required = false,
      disabled = false,
      className = '',
      id: providedId,
    },
    ref
  ) => {
    const generatedId = useId();
    const selectId = providedId || generatedId;
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Dışarı tıklandığında kapat
    useEffect(() => {
      const handleClickOutside = (event: MouseEvent) => {
        if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
          setIsOpen(false);
        }
      };

      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleToggle = (optionValue: string) => {
      if (disabled) return;

      const newValue = value.includes(optionValue)
        ? value.filter((v) => v !== optionValue)
        : [...value, optionValue];
      onChange(newValue);
    };

    const handleRemove = (optionValue: string, e: React.MouseEvent) => {
      e.stopPropagation();
      if (disabled) return;
      onChange(value.filter((v) => v !== optionValue));
    };

    const selectedOptions = options.filter((opt) => value.includes(opt.value));

    const inputStateStyles = error
      ? 'border-red-500 focus-within:ring-red-500 focus-within:border-red-500'
      : 'border-gray-300 focus-within:ring-blue-500 focus-within:border-blue-500';

    const disabledStyles = disabled
      ? 'bg-gray-100 cursor-not-allowed'
      : 'bg-white cursor-pointer';

    return (
      <div ref={ref} className={`${fullWidth ? 'w-full' : ''} ${className}`}>
        {/* Etiket */}
        {label && (
          <label
            htmlFor={selectId}
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            {label}
            {required && <span className="text-red-500 ml-1">*</span>}
          </label>
        )}

        {/* Select container */}
        <div ref={containerRef} className="relative">
          {/* Trigger */}
          <div
            id={selectId}
            role="combobox"
            aria-expanded={isOpen}
            aria-haspopup="listbox"
            aria-invalid={!!error}
            tabIndex={disabled ? -1 : 0}
            onClick={() => !disabled && setIsOpen(!isOpen)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                !disabled && setIsOpen(!isOpen);
              }
              if (e.key === 'Escape') {
                setIsOpen(false);
              }
            }}
            className={`
              flex flex-wrap items-center gap-1
              rounded-lg border
              transition-colors duration-200
              focus:outline-none focus-within:ring-2
              ${sizeStyles[size]}
              ${inputStateStyles}
              ${disabledStyles}
              pr-10
            `}
          >
            {/* Seçili değerler (chips) */}
            {selectedOptions.length > 0 ? (
              selectedOptions.map((opt) => (
                <span
                  key={opt.value}
                  className={`
                    inline-flex items-center gap-1
                    bg-blue-100 text-blue-800 rounded
                    ${chipSizeStyles[size]}
                  `}
                >
                  {opt.label}
                  {!disabled && (
                    <button
                      type="button"
                      onClick={(e) => handleRemove(opt.value, e)}
                      className="hover:text-blue-600 focus:outline-none"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </span>
              ))
            ) : (
              <span className="text-gray-400">{placeholder}</span>
            )}

            {/* Dropdown ikonu */}
            <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
              <svg
                className={`w-5 h-5 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>

          {/* Dropdown menu */}
          {isOpen && (
            <div
              role="listbox"
              aria-multiselectable="true"
              className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-auto"
            >
              {options.length === 0 ? (
                <div className="px-3 py-2 text-gray-500 text-sm">No options available</div>
              ) : (
                options.map((option) => (
                  <div
                    key={option.value}
                    role="option"
                    aria-selected={value.includes(option.value)}
                    onClick={() => !option.disabled && handleToggle(option.value)}
                    className={`
                      flex items-center gap-2 px-3 py-2
                      ${option.disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-gray-100'}
                      ${value.includes(option.value) ? 'bg-blue-50' : ''}
                    `}
                  >
                    <input
                      type="checkbox"
                      checked={value.includes(option.value)}
                      disabled={option.disabled}
                      onChange={() => {}}
                      className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                    />
                    <span className="text-sm text-gray-700">{option.label}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Hata mesajı */}
        {error && (
          <p id={`${selectId}-error`} className="mt-1 text-sm text-red-600" role="alert">
            {error}
          </p>
        )}

        {/* Yardım metni */}
        {!error && helperText && (
          <p id={`${selectId}-helper`} className="mt-1 text-sm text-gray-500">
            {helperText}
          </p>
        )}
      </div>
    );
  }
);

MultiSelect.displayName = 'MultiSelect';

export default MultiSelect;
