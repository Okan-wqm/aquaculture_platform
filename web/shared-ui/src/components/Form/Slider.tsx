/**
 * Slider Bileşeni
 * Sayısal aralık seçimi için native range input üzerine kurulu form alanı.
 *
 * A range is still a form field: it needs a bound label, a label that reads at
 * the size of the field around it, and one place that decides how the accent
 * and the numeric readout look. Without a primitive, 19 call sites re-derived
 * all of that — three different accent hues between them, and a readout that
 * sat beside the label in one panel and under the track in the next, while
 * most of them bound no label to the control at all (FE-MEDIUM-157).
 *
 * Every one of those call sites also parsed the DOM value by hand, and not the
 * same way twice: parseInt here, parseFloat there, Number elsewhere. On a
 * fractional step parseInt silently truncates, so the parse was a correctness
 * surface, not a formality. This component hands the caller a number and
 * removes the surface entirely.
 *
 * Three readout placements occur in the wild and all three are supported:
 * beside the label, below the track, or none at all. The default format reads
 * the decimals off the step, which is what the hand-written sites worked out
 * one at a time; pass formatValue to override it.
 *
 * Pass a label when the range is its own field. When it is a bare track in a
 * repeat row with nothing to bind to, pass an accessible name instead — from
 * useI18n at the call site, never written into the file.
 */

import { forwardRef, InputHTMLAttributes, useId } from 'react';
import type { Size } from '../../types';
import { fieldLabelClass, fieldLabelTextSize } from './fieldLabel';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

export interface SliderProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'size' | 'type' | 'value' | 'onChange' | 'min' | 'max' | 'step'
  > {
  /** Alan etiketi — kontrole bağlanır */
  label?: string;
  /** Geçerli değer */
  value: number;
  /** Alt sınır */
  min?: number;
  /** Üst sınır */
  max?: number;
  /** Adım */
  step?: number;
  /** Değer değiştiğinde — DOM değeri zaten sayıya çevrilmiştir */
  onChange: (value: number) => void;
  /** Kontrol boyutu — etiket ve okuma da bu boyutta okunur */
  size?: Size;
  /** Sayısal okumanın yeri */
  readout?: 'none' | 'beside-label' | 'below';
  /** Okumanın biçimi — verilmezse ondalık basamak adımdan türetilir */
  formatValue?: (value: number) => string;
  /** Okumanın sonuna eklenen birim */
  unit?: string;
  /** Yardım metni */
  helperText?: string;
  /** Hata mesajı */
  error?: string;
  /** Tam genişlik */
  fullWidth?: boolean;
  /** Zorunlu alan göstergesi */
  required?: boolean;
}

// ============================================================================
// Stil Sınıfları
// ============================================================================

/**
 * İz yüksekliği BİLEREK dayatılmaz. 19 çağrı yerinin 17'si yüksekliği hiç
 * ayarlamıyor ve tarayıcının kendi ölçüsünü kullanıyor; yalnızca ikisi bir
 * kıl payı (h-1 ve h-1.5) dayatıyordu. Bir range girdisinde bu sınıf iz
 * kalınlığını değil, elemanın tamamının yüksekliğini — yani işaretçi hedefini
 * — belirler, dolayısıyla o iki yer kendi hedefini 4-6 piksele indiriyordu.
 * `size` burada alanın METİN ölçeğidir; hedef boyutu tarayıcıya bırakılır.
 */

/**
 * Ondalık basamak adımdan türetilir: 1 ve üzeri adım tam sayı okur, 0.1'e kadar
 * bir basamak, daha incesi iki basamak. Elle yazılmış çağrı yerlerinin teker
 * teker vardığı kural buydu; burada bir kez yazılır.
 */
const defaultFormat = (value: number, step: number): string =>
  value.toFixed(step >= 1 ? 0 : step < 0.1 ? 2 : 1);

// ============================================================================
// Slider Bileşeni
// ============================================================================

/** Slider bileşeni — kullanım için yukarıdaki dosya başlığına bakın. */
export const Slider = forwardRef<HTMLInputElement, SliderProps>(
  (
    {
      label,
      value,
      min = 0,
      max = 100,
      step = 1,
      onChange,
      size = 'md',
      readout = 'none',
      formatValue,
      unit,
      helperText,
      error,
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

    const reading = `${formatValue ? formatValue(value) : defaultFormat(value, step)}${unit ?? ''}`;
    const readoutClass = `font-mono ${fieldLabelTextSize[size]} text-gray-600 dark:text-gray-400`;

    return (
      <div className={`${fullWidth ? 'w-full' : ''} ${className}`.trim()}>
        {/* Etiket ve — istenirse — aynı satırdaki okuma */}
        {(label || readout === 'beside-label') && (
          <div className="flex items-baseline justify-between gap-2">
            {label && (
              <label htmlFor={inputId} className={fieldLabelClass(size)}>
                {label}
                {required && <span className="text-error-500 ml-1">*</span>}
              </label>
            )}
            {readout === 'beside-label' && (
              <span className={`${readoutClass} mb-1`}>{reading}</span>
            )}
          </div>
        )}

        <input
          ref={ref}
          id={inputId}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          required={required}
          aria-required={required || undefined}
          aria-invalid={!!error}
          aria-describedby={
            error ? `${inputId}-error` : helperText ? `${inputId}-helper` : undefined
          }
          onChange={(event) => onChange(Number(event.target.value))}
          className={`
            w-full
            accent-primary-600
            ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}
          `
            .replace(/\s+/g, ' ')
            .trim()}
          {...props}
        />

        {/* İzin altındaki okuma — sağa yaslı, izin bittiği yere hizalanır */}
        {readout === 'below' && (
          <span className={`${readoutClass} block text-right`}>{reading}</span>
        )}

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

Slider.displayName = 'Slider';
