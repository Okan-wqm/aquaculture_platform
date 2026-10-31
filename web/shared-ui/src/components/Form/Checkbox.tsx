/**
 * Checkbox ve Switch Bileşenleri
 * Boolean değer girişleri için yeniden kullanılabilir bileşenler
 */

import React, { forwardRef, InputHTMLAttributes, useId } from 'react';

// ============================================================================
// Checkbox Tip Tanımlamaları
// ============================================================================

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> {
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
  /**
   * Yüzey varyantı. 'glass' = buzlu auth kartı için tasarım-token'larını kullanır.
   */
  surface?: 'default' | 'glass';
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
      surface = 'default',
      className = '',
      id: providedId,
      ...props
    },
    ref,
  ) => {
    const generatedId = useId();
    const checkboxId = providedId || generatedId;
    const isGlass = surface === 'glass';
    // Glass yüzeyde renk token'larını kullan (rakip utility olmaması için değiştir).
    const checkboxSurfaceStyle = isGlass
      ? 'text-[var(--surface-btn-bg)] border-[var(--surface-field-border)] focus:ring-[var(--surface-field-focus-ring)]'
      : 'text-primary-600 border-gray-300 dark:border-gray-600 focus:ring-primary-500';

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
      [indeterminate, ref],
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
              ${checkboxSurfaceStyle}
              rounded
              focus:ring-2 focus:ring-offset-0
              disabled:opacity-50 disabled:cursor-not-allowed
              ${error ? 'border-error-500' : ''}
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
                  font-medium ${isGlass ? 'text-[var(--surface-label-fg)]' : 'text-gray-700 dark:text-gray-300'}
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
                className="text-sm text-gray-500 dark:text-gray-400 mt-0.5"
              >
                {description}
              </p>
            )}
            {error && (
              <p className="text-sm text-error-600 dark:text-error-400 mt-1" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </div>
    );
  },
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
  /**
   * Where the label and description sit. `end` (default): after the track.
   * `start`: before it, the track at the row's far edge — a settings list
   * row, label on the left and the switch on the right.
   */
  labelPlacement?: 'end' | 'start';
}

const switchSizeStyles = {
  sm: { track: 'w-8 h-4', thumb: 'w-3 h-3', translate: 'translate-x-4' },
  md: { track: 'w-11 h-6', thumb: 'w-5 h-5', translate: 'translate-x-5' },
  lg: { track: 'w-14 h-7', thumb: 'w-6 h-6', translate: 'translate-x-7' },
};

/**
 * Switch bileşeni
 *
 * One control for assistive technology and the keyboard: the track is the
 * `role="switch"` button, named by the visible label (`aria-labelledby`) and
 * described by the description line (`aria-describedby`). The checkbox under
 * it exists for forms (`ref`, `name`, the label's click) and is hidden from
 * both — otherwise a screen reader meets the same setting twice and Tab stops
 * on it twice. Focus draws the accent ring for keyboard focus only.
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
      labelPlacement = 'end',
      disabled = false,
      checked = false,
      className = '',
      id: providedId,
      onChange,
      ...props
    },
    ref,
  ) => {
    const generatedId = useId();
    const switchId = providedId || generatedId;
    const styles = switchSizeStyles[size];
    const labelId = `${switchId}-label`;
    const descriptionId = `${switchId}-description`;
    const labelFirst = labelPlacement === 'start';

    const text = (label || description) && (
      <div className={labelFirst ? 'min-w-0' : 'ml-3'}>
        {label && (
          <label
            id={labelId}
            htmlFor={switchId}
            className={`
              font-medium text-gray-700 dark:text-gray-300
              ${labelSizeStyles[size]}
              ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
            `}
          >
            {label}
          </label>
        )}
        {description && (
          <p id={descriptionId} className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            {description}
          </p>
        )}
      </div>
    );

    return (
      <div
        className={`flex ${labelFirst ? 'items-center justify-between gap-4' : 'items-start'} ${className}`}
      >
        {labelFirst && text}
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-labelledby={label ? labelId : undefined}
          aria-describedby={description ? descriptionId : undefined}
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
            focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2
            ${checked ? 'bg-primary-600' : 'bg-gray-200 dark:bg-gray-700'}
            ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
          `}
        >
          <span
            className={`
              ${styles.thumb}
              pointer-events-none inline-block
              rounded-full bg-white dark:bg-gray-900 shadow-lg
              transform ring-0
              transition duration-200 ease-in-out
              ${checked ? styles.translate : 'translate-x-0.5'}
            `}
            style={{ marginTop: '0.125rem' }}
          />
        </button>

        {/* Gizli input (form uyumluluğu için) — the switch above is the one control */}
        <input
          ref={ref}
          type="checkbox"
          id={switchId}
          checked={checked}
          disabled={disabled}
          onChange={onChange}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          {...props}
        />

        {!labelFirst && text}
      </div>
    );
  },
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
  /** Kart varyantı: etiketin yanındaki kısa işaret (ör. seviye çipi) — erişilebilir adın parçası */
  labelSuffix?: React.ReactNode;
  /** Kart varyantı: metnin önündeki görsel (ör. avatar) — dekoratif, ekran okuyucudan gizli */
  media?: React.ReactNode;
  /** Kart varyantı: açıklamanın altındaki ek içerik (ör. yetenek çipleri) — görsel, ekran okuyucudan gizli */
  details?: React.ReactNode;
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
  /**
   * Görünüm. 'list' (varsayılan) = metin satırı; 'card' = her seçenek bir kart (media, etiket +
   * suffix, açıklama, details) ve kartın tamamı tıklama alanı. İkisi de aynı yerel radio'yu
   * kullanır: klavye, form ve seçili durum platformundur.
   */
  variant?: 'list' | 'card';
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
  variant = 'list',
  className = '',
}) => {
  const groupId = useId();

  return (
    <fieldset className={className}>
      {label && (
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          {label}
        </legend>
      )}
      <div className={`${vertical ? 'space-y-2' : 'flex flex-wrap gap-4'}`}>
        {options.map((option, index) => {
          // Ids from the position, not the value: they are joined into aria-labelledby /
          // aria-describedby id lists, where a value containing a space would split the reference.
          const optionId = `${groupId}-${index}`;
          const labelId = `${optionId}-label`;
          const suffixId = `${optionId}-suffix`;
          const descriptionId = option.description ? `${optionId}-description` : undefined;
          const isDisabled = disabled || option.disabled;
          const checked = value === option.value;
          const hasSuffix = option.labelSuffix !== undefined && option.labelSuffix !== null;

          // One radio for both variants. Its name is the label (+ suffix) and its description
          // the description — never the whole card, whose media and details are visual.
          const radio = (
            <input
              type="radio"
              id={optionId}
              name={name}
              value={option.value}
              checked={checked}
              disabled={isDisabled}
              onChange={() => onChange?.(option.value)}
              aria-labelledby={hasSuffix ? `${labelId} ${suffixId}` : labelId}
              aria-describedby={descriptionId}
              className={`
                ${checkboxSizeStyles[size]}
                text-primary-600
                border-gray-300 dark:border-gray-600
                focus:ring-primary-500 focus:ring-2
                disabled:opacity-50 disabled:cursor-not-allowed
                ${error ? 'border-error-500' : ''}
              `}
            />
          );

          if (variant === 'card') {
            return (
              <label
                key={option.value}
                htmlFor={optionId}
                data-selected={checked}
                className={`
                  flex items-start gap-3 rounded-lg border p-3 transition-colors
                  has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2
                  has-[:focus-visible]:outline-primary-500
                  ${
                    checked
                      ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                      : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50'
                  }
                  ${isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                `}
              >
                <span className="flex items-center h-5 mt-0.5">{radio}</span>
                {option.media && (
                  <span className="flex shrink-0" aria-hidden="true">
                    {option.media}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span
                      id={labelId}
                      className={`font-medium text-gray-900 dark:text-gray-100 ${labelSizeStyles[size]}`}
                    >
                      {option.label}
                    </span>
                    {hasSuffix && <span id={suffixId}>{option.labelSuffix}</span>}
                  </span>
                  {option.description && (
                    <span
                      id={descriptionId}
                      className="mt-0.5 block text-sm text-gray-500 dark:text-gray-400"
                    >
                      {option.description}
                    </span>
                  )}
                  {option.details && (
                    <span className="mt-2 block" aria-hidden="true">
                      {option.details}
                    </span>
                  )}
                </span>
              </label>
            );
          }

          return (
            <div key={option.value} className="flex items-start">
              <div className="flex items-center h-5">{radio}</div>
              <div className="ml-3">
                <label
                  id={labelId}
                  htmlFor={optionId}
                  className={`
                    font-medium text-gray-700 dark:text-gray-300
                    ${labelSizeStyles[size]}
                    ${isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                  `}
                >
                  {option.label}
                </label>
                {hasSuffix && <span id={suffixId}>{option.labelSuffix}</span>}
                {option.description && (
                  <p id={descriptionId} className="text-sm text-gray-500 dark:text-gray-400">
                    {option.description}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {error && (
        <p className="mt-2 text-sm text-error-600 dark:text-error-400" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
};

export default Checkbox;
