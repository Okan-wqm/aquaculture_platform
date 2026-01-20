/**
 * Input Bileşeni
 * Form girişleri için yeniden kullanılabilir text input
 * Etiket, hata mesajı, ikon desteği ve çeşitli varyantlar
 */

import React, { forwardRef, InputHTMLAttributes, useId } from 'react';
import type { Size } from '../../types';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Input etiketi */
  label?: string;
  /** Hata mesajı */
  error?: string;
  /** Yardım metni */
  helperText?: string;
  /** Yardım metni (alias for helperText) */
  hint?: string;
  /** Input boyutu */
  size?: Size;
  /** Sol ikon */
  leftIcon?: React.ReactNode;
  /** Sağ ikon veya element */
  rightElement?: React.ReactNode;
  /** Tam genişlik */
  fullWidth?: boolean;
  /** Zorunlu alan göstergesi */
  required?: boolean;
}

// ============================================================================
// Stil Sınıfları
// ============================================================================

const sizeStyles: Record<Size, { input: string; icon: string }> = {
  xs: { input: 'px-2 py-1 text-xs', icon: 'w-3 h-3' },
  sm: { input: 'px-3 py-1.5 text-sm', icon: 'w-4 h-4' },
  md: { input: 'px-3 py-2 text-sm', icon: 'w-5 h-5' },
  lg: { input: 'px-4 py-2.5 text-base', icon: 'w-5 h-5' },
  xl: { input: 'px-4 py-3 text-lg', icon: 'w-6 h-6' },
};

// ============================================================================
// Input Bileşeni
// ============================================================================

/**
 * Input bileşeni
 *
 * @example
 * // Temel kullanım
 * <Input
 *   label="E-posta"
 *   type="email"
 *   placeholder="ornek@email.com"
 * />
 *
 * @example
 * // Hata durumu ile
 * <Input
 *   label="Şifre"
 *   type="password"
 *   error="Şifre en az 8 karakter olmalı"
 * />
 *
 * @example
 * // İkon ile
 * <Input
 *   label="Ara"
 *   leftIcon={<SearchIcon />}
 *   placeholder="Çiftlik ara..."
 * />
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      error,
      helperText: helperTextProp,
      hint,
      size = 'md',
      leftIcon,
      rightElement,
      fullWidth = true,
      required = false,
      disabled = false,
      className = '',
      id: providedId,
      ...props
    },
    ref
  ) => {
    // hint ve helperText'i birleştir
    const helperText = helperTextProp || hint;
    // Benzersiz ID oluştur (eğer sağlanmadıysa)
    const generatedId = useId();
    const inputId = providedId || generatedId;

    // Input durumuna göre stil sınıfları
    const inputStateStyles = error
      ? 'border-red-500 focus:ring-red-500 focus:border-red-500'
      : 'border-gray-300 focus:ring-blue-500 focus:border-blue-500';

    const disabledStyles = disabled
      ? 'bg-gray-100 cursor-not-allowed text-gray-500'
      : 'bg-white';

    // Sol ikon için padding
    const leftPadding = leftIcon ? 'pl-10' : '';
    // Sağ element için padding
    const rightPadding = rightElement ? 'pr-10' : '';

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
          {/* Sol ikon */}
          {leftIcon && (
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <span className={`text-gray-400 ${sizeStyles[size].icon}`}>
                {leftIcon}
              </span>
            </div>
          )}

          {/* Input elementi */}
          <input
            ref={ref}
            id={inputId}
            disabled={disabled}
            aria-invalid={!!error}
            aria-describedby={error ? `${inputId}-error` : helperText ? `${inputId}-helper` : undefined}
            className={`
              block w-full rounded-lg border
              transition-colors duration-200
              focus:outline-none focus:ring-2
              ${sizeStyles[size].input}
              ${inputStateStyles}
              ${disabledStyles}
              ${leftPadding}
              ${rightPadding}
            `}
            {...props}
          />

          {/* Sağ element */}
          {rightElement && (
            <div className="absolute inset-y-0 right-0 pr-3 flex items-center">
              {rightElement}
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

Input.displayName = 'Input';

// ============================================================================
// Textarea Bileşeni
// ============================================================================

export interface TextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'> {
  label?: string;
  error?: string;
  helperText?: string;
  size?: Size;
  fullWidth?: boolean;
  required?: boolean;
}

/**
 * Textarea bileşeni
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    {
      label,
      error,
      helperText,
      size = 'md',
      fullWidth = true,
      required = false,
      disabled = false,
      className = '',
      rows = 4,
      id: providedId,
      ...props
    },
    ref
  ) => {
    const generatedId = useId();
    const textareaId = providedId || generatedId;

    const inputStateStyles = error
      ? 'border-red-500 focus:ring-red-500 focus:border-red-500'
      : 'border-gray-300 focus:ring-blue-500 focus:border-blue-500';

    const disabledStyles = disabled
      ? 'bg-gray-100 cursor-not-allowed text-gray-500'
      : 'bg-white';

    return (
      <div className={`${fullWidth ? 'w-full' : ''} ${className}`}>
        {label && (
          <label
            htmlFor={textareaId}
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            {label}
            {required && <span className="text-red-500 ml-1">*</span>}
          </label>
        )}

        <textarea
          ref={ref}
          id={textareaId}
          rows={rows}
          disabled={disabled}
          aria-invalid={!!error}
          className={`
            block w-full rounded-lg border
            transition-colors duration-200
            focus:outline-none focus:ring-2
            resize-y
            ${sizeStyles[size].input}
            ${inputStateStyles}
            ${disabledStyles}
          `}
          {...props}
        />

        {error && (
          <p className="mt-1 text-sm text-red-600" role="alert">
            {error}
          </p>
        )}

        {!error && helperText && (
          <p className="mt-1 text-sm text-gray-500">{helperText}</p>
        )}
      </div>
    );
  }
);

Textarea.displayName = 'Textarea';

export default Input;
