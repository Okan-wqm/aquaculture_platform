/**
 * ColorInput Bileşeni
 * Renk seçimi için `<input type="color">` üzerine kurulu form alanı.
 *
 * A colour field is still a form field: it needs a bound label, a size that
 * matches the controls beside it, and one place that decides how the swatch
 * looks. Without a primitive, 39 call sites re-derived that themselves —
 * `w-full h-8` here, `w-8 h-8` there, `w-6 h-6` in a repeat row — each with a
 * hand-written `<label>` that mostly bound to nothing and an ad-hoc aria-label
 * that sometimes contradicted it (FE-HIGH-079).
 *
 * Two shapes cover every one of those call sites:
 *   - `bar`    — fills its container, the shape used when the colour is a field
 *                of its own with a label above it.
 *   - `swatch` — a fixed square sized from `size`, the shape used when the
 *                colour sits inline beside other controls in a row.
 */

import { forwardRef, InputHTMLAttributes, useId } from 'react';
import type { Size } from '../../types';
import { fieldLabelClass } from './fieldLabel';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

export interface ColorInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> {
  /** Alan etiketi — kontrole bağlanır */
  label?: string;
  /** Yardım metni */
  helperText?: string;
  /** Hata mesajı */
  error?: string;
  /** Kontrol boyutu — etiket de bu boyutta okunur */
  size?: Size;
  /** Şekil: kendi alanı olan bir çubuk mu, satır içi bir kare mi */
  variant?: 'bar' | 'swatch';
  /** Tam genişlik (yalnızca `bar`) */
  fullWidth?: boolean;
  /** Zorunlu alan göstergesi */
  required?: boolean;
}

// ============================================================================
// Stil Sınıfları
// ============================================================================

/** Yükseklik kontrolün boyutunu izler; `swatch` aynı ölçüde kare olur. */
const swatchSizeStyles: Record<Size, { bar: string; swatch: string }> = {
  xs: { bar: 'h-6', swatch: 'w-6 h-6' },
  sm: { bar: 'h-7', swatch: 'w-7 h-7' },
  md: { bar: 'h-8', swatch: 'w-8 h-8' },
  lg: { bar: 'h-10', swatch: 'w-10 h-10' },
  xl: { bar: 'h-12', swatch: 'w-12 h-12' },
};

// ============================================================================
// ColorInput Bileşeni
// ============================================================================

/**
 * ColorInput bileşeni
 *
 * @example
 * // Kendi alanı olan bir renk
 * <ColorInput label="Dolgu Rengi" value={fill} onChange={(e) => setFill(e.target.value)} />
 *
 * @example
 * // Satır içinde, diğer kontrollerin yanında
 * <ColorInput aria-label="Bölge rengi" variant="swatch" size="sm" value={zone.color} onChange={…} />
 */
export const ColorInput = forwardRef<HTMLInputElement, ColorInputProps>(
  (
    {
      label,
      helperText,
      error,
      size = 'md',
      variant = 'bar',
      fullWidth = true,
      required = false,
      disabled = false,
      className = '',
      id: providedId,
      ...props
    },
    ref,
  ) => {
    const generatedId = useId();
    const inputId = providedId || generatedId;

    const shape =
      variant === 'swatch'
        ? `${swatchSizeStyles[size].swatch} shrink-0`
        : `${fullWidth ? 'w-full' : ''} ${swatchSizeStyles[size].bar}`;

    const borderStyles = error ? 'border-error-500' : 'border-gray-300 dark:border-gray-600';

    return (
      <div
        className={variant === 'swatch' ? className : `${fullWidth ? 'w-full' : ''} ${className}`}
      >
        {/* Etiket */}
        {label && (
          <label htmlFor={inputId} className={fieldLabelClass(size)}>
            {label}
            {required && <span className="text-error-500 ml-1">*</span>}
          </label>
        )}

        <input
          ref={ref}
          id={inputId}
          type="color"
          disabled={disabled}
          required={required}
          aria-required={required || undefined}
          aria-invalid={!!error}
          aria-describedby={
            error ? `${inputId}-error` : helperText ? `${inputId}-helper` : undefined
          }
          className={`
            ${shape}
            rounded-lg border p-0
            ${borderStyles}
            ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}
          `
            .replace(/\s+/g, ' ')
            .trim()}
          {...props}
        />

        {/* Hata / yardım metni */}
        {error && (
          <p id={`${inputId}-error`} className="mt-1 text-sm text-error-600 dark:text-error-400">
            {error}
          </p>
        )}
        {!error && helperText && (
          <p id={`${inputId}-helper`} className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {helperText}
          </p>
        )}
      </div>
    );
  },
);

ColorInput.displayName = 'ColorInput';
