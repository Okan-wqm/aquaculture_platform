/**
 * NumberInput Bileşeni
 * Sayısal girişler için özelleştirilmiş input
 * Birim (unit) gösterimi ve min/max desteği
 */

import React, { forwardRef, InputHTMLAttributes, useId } from 'react';
import type { Size } from '../../types';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

export interface NumberInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> {
  /** Input etiketi */
  label?: string;
  /** Hata mesajı */
  error?: string;
  /** Yardım metni */
  helperText?: string;
  /** Input boyutu */
  size?: Size;
  /** Birim gösterimi (örn: kW, m³, %) */
  unit?: string;
  /** Tam genişlik */
  fullWidth?: boolean;
  /** Zorunlu alan göstergesi */
  required?: boolean;
}

// ============================================================================
// Stil Sınıfları
// ============================================================================

const sizeStyles: Record<Size, { input: string; unit: string }> = {
  xs: { input: 'px-2 py-1 text-xs', unit: 'text-xs' },
  sm: { input: 'px-3 py-1.5 text-sm', unit: 'text-sm' },
  md: { input: 'px-3 py-2 text-sm', unit: 'text-sm' },
  lg: { input: 'px-4 py-2.5 text-base', unit: 'text-base' },
  xl: { input: 'px-4 py-3 text-lg', unit: 'text-lg' },
};

// ============================================================================
// NumberInput Bileşeni
// ============================================================================

/**
 * NumberInput bileşeni
 *
 * @example
 * // Temel kullanım
 * <NumberInput
 *   label="Hacim"
 *   unit="m³"
 *   value={volume}
 *   onChange={(e) => setVolume(e.target.value)}
 * />
 *
 * @example
 * // Min/Max ile
 * <NumberInput
 *   label="Sıcaklık"
 *   unit="°C"
 *   min={0}
 *   max={100}
 *   step={0.1}
 * />
 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(
  (
    {
      label,
      error,
      helperText,
      size = 'md',
      unit,
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
    const inputId = providedId || generatedId;

    const inputStateStyles = error
      ? 'border-red-500 focus:ring-red-500 focus:border-red-500'
      : 'border-gray-300 focus:ring-blue-500 focus:border-blue-500';

    const disabledStyles = disabled
      ? 'bg-gray-100 cursor-not-allowed text-gray-500'
      : 'bg-white';

    // Unit için sağ padding
    const rightPadding = unit ? 'pr-12' : '';

    return (
      <div className={`${fullWidth ? 'w-full' : ''} ${className}`}>
        {/* Etiket */}
        {label && (
          <label
            htmlFor={inputId}
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            {label}
            {required && <span className="text-red-500 ml-1">*</span>}
          </label>
        )}

        {/* Input sarmalayıcı */}
        <div className="relative">
          {/* Input elementi */}
          <input
            ref={ref}
            id={inputId}
            type="number"
            disabled={disabled}
            aria-invalid={!!error}
            aria-describedby={
              error ? `${inputId}-error` : helperText ? `${inputId}-helper` : undefined
            }
            className={`
              block w-full rounded-lg border
              transition-colors duration-200
              focus:outline-none focus:ring-2
              ${sizeStyles[size].input}
              ${inputStateStyles}
              ${disabledStyles}
              ${rightPadding}
              [appearance:textfield]
              [&::-webkit-outer-spin-button]:appearance-none
              [&::-webkit-inner-spin-button]:appearance-none
            `}
            {...props}
          />

          {/* Birim gösterimi */}
          {unit && (
            <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
              <span className={`text-gray-500 ${sizeStyles[size].unit}`}>
                {unit}
              </span>
            </div>
          )}
        </div>

        {/* Hata mesajı */}
        {error && (
          <p id={`${inputId}-error`} className="mt-1 text-sm text-red-600" role="alert">
            {error}
          </p>
        )}

        {/* Yardım metni */}
        {!error && helperText && (
          <p id={`${inputId}-helper`} className="mt-1 text-sm text-gray-500">
            {helperText}
          </p>
        )}
      </div>
    );
  }
);

NumberInput.displayName = 'NumberInput';

export default NumberInput;
