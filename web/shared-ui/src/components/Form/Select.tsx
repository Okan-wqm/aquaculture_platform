/**
 * Select Bileşeni
 * Dropdown seçim alanı için yeniden kullanılabilir bileşen
 * Native select elementi üzerine özelleştirilmiş stil
 */

import { forwardRef, SelectHTMLAttributes, useId } from 'react';
import type { Size } from '../../types';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

export interface SelectOption {
  /** Seçenek değeri */
  value: string | number;
  /** Görüntülenen etiket */
  label: string;
  /** Devre dışı mı */
  disabled?: boolean;
  /** Grup başlığı (optgroup için) */
  group?: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  /** Select etiketi */
  label?: string;
  /** Seçenek listesi */
  options: SelectOption[];
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
}

// ============================================================================
// Stil Sınıfları
// ============================================================================

const sizeStyles: Record<Size, string> = {
  xs: 'px-2 py-1 text-xs',
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-3 py-2 text-sm',
  lg: 'px-4 py-2.5 text-base',
  xl: 'px-4 py-3 text-lg',
};

// ============================================================================
// Select Bileşeni
// ============================================================================

/**
 * Select bileşeni
 *
 * @example
 * // Temel kullanım
 * <Select
 *   label="Çiftlik Seç"
 *   options={[
 *     { value: 'farm1', label: 'Çiftlik 1' },
 *     { value: 'farm2', label: 'Çiftlik 2' },
 *   ]}
 *   onChange={(e) => setSelectedFarm(e.target.value)}
 * />
 *
 * @example
 * // Placeholder ile
 * <Select
 *   label="Durum"
 *   placeholder="Durum seçin..."
 *   options={statusOptions}
 * />
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      label,
      options,
      error,
      helperText,
      size = 'md',
      placeholder,
      fullWidth = true,
      required = false,
      disabled = false,
      className = '',
      id: providedId,
      ...props
    },
    ref
  ) => {
    const generatedId = useId();
    const selectId = providedId || generatedId;

    // Ensure options is always an array
    const safeOptions = options || [];

    // Seçenekleri grupla
    const groupedOptions = safeOptions.reduce((acc, option) => {
      const group = option.group || '__ungrouped__';
      if (!acc[group]) acc[group] = [];
      acc[group].push(option);
      return acc;
    }, {} as Record<string, SelectOption[]>);

    const hasGroups = Object.keys(groupedOptions).some((key) => key !== '__ungrouped__');

    const inputStateStyles = error
      ? 'border-red-500 focus:ring-red-500 focus:border-red-500'
      : 'border-gray-300 focus:ring-blue-500 focus:border-blue-500';

    const disabledStyles = disabled
      ? 'bg-gray-100 cursor-not-allowed text-gray-500'
      : 'bg-white';

    return (
      <div className={`${fullWidth ? 'w-full' : ''} ${className}`}>
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

        {/* Select elementi */}
        <div className="relative">
          <select
            ref={ref}
            id={selectId}
            disabled={disabled}
            aria-invalid={!!error}
            aria-describedby={
              error ? `${selectId}-error` : helperText ? `${selectId}-helper` : undefined
            }
            className={`
              block w-full rounded-lg border
              transition-colors duration-200
              focus:outline-none focus:ring-2
              appearance-none
              pr-10
              ${sizeStyles[size]}
              ${inputStateStyles}
              ${disabledStyles}
            `}
            {...props}
          >
            {/* Placeholder seçeneği */}
            {placeholder && (
              <option value="" disabled>
                {placeholder}
              </option>
            )}

            {/* Seçenekler */}
            {hasGroups ? (
              // Gruplu seçenekler
              Object.entries(groupedOptions).map(([groupName, groupOptions]) =>
                groupName === '__ungrouped__' ? (
                  groupOptions.map((option) => (
                    <option
                      key={option.value}
                      value={option.value}
                      disabled={option.disabled}
                    >
                      {option.label}
                    </option>
                  ))
                ) : (
                  <optgroup key={groupName} label={groupName}>
                    {groupOptions.map((option) => (
                      <option
                        key={option.value}
                        value={option.value}
                        disabled={option.disabled}
                      >
                        {option.label}
                      </option>
                    ))}
                  </optgroup>
                )
              )
            ) : (
              // Gruplu olmayan seçenekler
              safeOptions.map((option) => (
                <option
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                >
                  {option.label}
                </option>
              ))
            )}
          </select>

          {/* Dropdown ikonu */}
          <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
            <svg
              className="w-5 h-5 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </div>
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

Select.displayName = 'Select';

export default Select;
