/**
 * Checkbox ve Switch Bileşenleri
 * Boolean değer girişleri için yeniden kullanılabilir bileşenler
 */

import React, { forwardRef, InputHTMLAttributes, useId } from 'react';

// ============================================================================
// Checkbox Tip Tanımlamaları
// ============================================================================

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> {
  /** Checkbox etiketi */
  label?: string;
  /** Açıklama metni */
  description?: string;
  /** Hata mesajı */
  error?: string;
  /** Boyut */
  size?: 'sm' | 'md' | 'lg';
  /** Belirsiz durumu */
  indeterminate?: boolean;
}

// ============================================================================
// Checkbox Stil Sınıfları
// ============================================================================

const checkboxSizeStyles = {
  sm: 'w-4 h-4',
  md: 'w-5 h-5',
  lg: 'w-6 h-6',
};

const labelSizeStyles = {
  sm: 'text-sm',
  md: 'text-sm',
  lg: 'text-base',
};

// ============================================================================
// Checkbox Bileşeni
// ============================================================================

/**
 * Checkbox bileşeni
 *
 * @example
 * // Temel kullanım
 * <Checkbox
 *   label="Şartları kabul ediyorum"
 *   checked={accepted}
 *   onChange={(e) => setAccepted(e.target.checked)}
 * />
 *
 * @example
 * // Açıklama ile
 * <Checkbox
 *   label="E-posta bildirimleri"
 *   description="Önemli güncellemeler hakkında bilgilendirilmek istiyorum"
 * />
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  (
    {
      label,
      description,
      error,
      size = 'md',
      indeterminate = false,
      disabled = false,
      className = '',
      id: providedId,
      ...props
    },
    ref
  ) => {
    const generatedId = useId();
    const checkboxId = providedId || generatedId;

    // Indeterminate durumu için ref callback
    const checkboxRef = React.useCallback(
      (node: HTMLInputElement | null) => {
        if (node) {
          node.indeterminate = indeterminate;
        }
        // Forward ref'i de ayarla
        if (typeof ref === 'function') {
          ref(node);
        } else if (ref) {
          ref.current = node;
        }
      },
      [indeterminate, ref]
    );

    return (
      <div className={`flex items-start ${className}`}>
        <div className="flex items-center h-5">
          <input
            ref={checkboxRef}
            type="checkbox"
            id={checkboxId}
            disabled={disabled}
            aria-invalid={!!error}
            aria-describedby={description ? `${checkboxId}-description` : undefined}
            className={`
              ${checkboxSizeStyles[size]}
              text-blue-600
              border-gray-300 rounded
              focus:ring-blue-500 focus:ring-2 focus:ring-offset-0
              disabled:opacity-50 disabled:cursor-not-allowed
              ${error ? 'border-red-500' : ''}
            `}
            {...props}
          />
        </div>
        {(label || description) && (
          <div className="ml-3">
            {label && (
              <label
                htmlFor={checkboxId}
                className={`
                  font-medium text-gray-700
                  ${labelSizeStyles[size]}
                  ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                `}
              >
                {label}
              </label>
            )}
            {description && (
              <p
                id={`${checkboxId}-description`}
                className="text-sm text-gray-500 mt-0.5"
              >
                {description}
              </p>
            )}
            {error && (
              <p className="text-sm text-red-600 mt-1" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </div>
    );
  }
);

Checkbox.displayName = 'Checkbox';

// ============================================================================
// Switch Bileşeni
// ============================================================================

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> {
  /** Switch etiketi */
  label?: string;
  /** Açıklama metni */
  description?: string;
  /** Boyut */
  size?: 'sm' | 'md' | 'lg';
}

const switchSizeStyles = {
  sm: { track: 'w-8 h-4', thumb: 'w-3 h-3', translate: 'translate-x-4' },
  md: { track: 'w-11 h-6', thumb: 'w-5 h-5', translate: 'translate-x-5' },
  lg: { track: 'w-14 h-7', thumb: 'w-6 h-6', translate: 'translate-x-7' },
};

/**
 * Switch bileşeni
 *
 * @example
 * <Switch
 *   label="Bildirimler"
 *   checked={notifications}
 *   onChange={(e) => setNotifications(e.target.checked)}
 * />
 */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(
  (
    {
      label,
      description,
      size = 'md',
      disabled = false,
      checked = false,
      className = '',
      id: providedId,
      onChange,
      ...props
    },
    ref
  ) => {
    const generatedId = useId();
    const switchId = providedId || generatedId;
    const styles = switchSizeStyles[size];

    return (
      <div className={`flex items-start ${className}`}>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-labelledby={label ? `${switchId}-label` : undefined}
          disabled={disabled}
          onClick={() => {
            if (onChange && !disabled) {
              const syntheticEvent = {
                target: { checked: !checked },
              } as React.ChangeEvent<HTMLInputElement>;
              onChange(syntheticEvent);
            }
          }}
          className={`
            ${styles.track}
            relative inline-flex flex-shrink-0
            rounded-full cursor-pointer
            transition-colors duration-200 ease-in-out
            focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
            ${checked ? 'bg-blue-600' : 'bg-gray-200'}
            ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
          `}
        >
          <span
            className={`
              ${styles.thumb}
              pointer-events-none inline-block
              rounded-full bg-white shadow-lg
              transform ring-0
              transition duration-200 ease-in-out
              ${checked ? styles.translate : 'translate-x-0.5'}
            `}
            style={{ marginTop: '0.125rem' }}
          />
        </button>

        {/* Gizli input (form uyumluluğu için) */}
        <input
          ref={ref}
          type="checkbox"
          id={switchId}
          checked={checked}
          disabled={disabled}
          onChange={onChange}
          className="sr-only"
          {...props}
        />

        {(label || description) && (
          <div className="ml-3">
            {label && (
              <label
                id={`${switchId}-label`}
                htmlFor={switchId}
                className={`
                  font-medium text-gray-700
                  ${labelSizeStyles[size]}
                  ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                `}
              >
                {label}
              </label>
            )}
            {description && (
              <p className="text-sm text-gray-500 mt-0.5">{description}</p>
            )}
          </div>
        )}
      </div>
    );
  }
);

Switch.displayName = 'Switch';

// ============================================================================
// Radio Bileşeni
// ============================================================================

export interface RadioOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface RadioGroupProps {
  /** Grup etiketi */
  label?: string;
  /** Radio seçenekleri */
  options: RadioOption[];
  /** Seçili değer */
  value?: string;
  /** Değer değişikliği */
  onChange?: (value: string) => void;
  /** Hata mesajı */
  error?: string;
  /** Dikey yerleşim */
  vertical?: boolean;
  /** Boyut */
  size?: 'sm' | 'md' | 'lg';
  /** Input adı */
  name: string;
  /** Devre dışı */
  disabled?: boolean;
  className?: string;
}

/**
 * RadioGroup bileşeni
 *
 * @example
 * <RadioGroup
 *   label="Durum"
 *   name="status"
 *   options={[
 *     { value: 'active', label: 'Aktif' },
 *     { value: 'inactive', label: 'Pasif' },
 *   ]}
 *   value={status}
 *   onChange={setStatus}
 * />
 */
export const RadioGroup: React.FC<RadioGroupProps> = ({
  label,
  options,
  value,
  onChange,
  error,
  vertical = true,
  size = 'md',
  name,
  disabled = false,
  className = '',
}) => {
  const groupId = useId();

  return (
    <fieldset className={className}>
      {label && (
        <legend className="text-sm font-medium text-gray-700 mb-2">{label}</legend>
      )}
      <div className={`${vertical ? 'space-y-2' : 'flex flex-wrap gap-4'}`}>
        {options.map((option) => {
          const optionId = `${groupId}-${option.value}`;
          const isDisabled = disabled || option.disabled;

          return (
            <div key={option.value} className="flex items-start">
              <div className="flex items-center h-5">
                <input
                  type="radio"
                  id={optionId}
                  name={name}
                  value={option.value}
                  checked={value === option.value}
                  disabled={isDisabled}
                  onChange={() => onChange?.(option.value)}
                  className={`
                    ${checkboxSizeStyles[size]}
                    text-blue-600
                    border-gray-300
                    focus:ring-blue-500 focus:ring-2
                    disabled:opacity-50 disabled:cursor-not-allowed
                    ${error ? 'border-red-500' : ''}
                  `}
                />
              </div>
              <div className="ml-3">
                <label
                  htmlFor={optionId}
                  className={`
                    font-medium text-gray-700
                    ${labelSizeStyles[size]}
                    ${isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                  `}
                >
                  {option.label}
                </label>
                {option.description && (
                  <p className="text-sm text-gray-500">{option.description}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {error && (
        <p className="mt-2 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
};

export default Checkbox;
