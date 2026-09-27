/**
 * Button Bileşeni
 * Aquaculture Platform için yeniden kullanılabilir buton komponenti
 * Çeşitli varyant, boyut ve durum desteği ile birlikte gelir
 */

import React, { forwardRef, ButtonHTMLAttributes } from 'react';
import type { ButtonVariant, Size } from '../../types';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Buton görünüm varyantı */
  variant?: ButtonVariant;
  /** Buton boyutu */
  size?: Size;
  /** Tam genişlik */
  fullWidth?: boolean;
  /** Yükleniyor durumu */
  isLoading?: boolean;
  /** Yükleniyor durumu (alias for isLoading) */
  loading?: boolean;
  /** Sol ikon */
  leftIcon?: React.ReactNode;
  /** Sağ ikon */
  rightIcon?: React.ReactNode;
  /** Sadece ikon modu */
  iconOnly?: boolean;
  /**
   * Yüzey varyantı. 'glass' = buzlu auth kartı için tasarım-token'larını
   * (var(--surface-btn-*)) kullanır ve `variant` rengini bu yüzeyde geçersiz kılar.
   */
  surface?: 'default' | 'glass';
}

// ============================================================================
// Stil Sınıfları
// ============================================================================

/**
 * Varyant bazlı stil sınıfları
 */
const variantStyles: Record<ButtonVariant, string> = {
  primary: `
    bg-primary-600 text-white
    hover:bg-primary-700
    focus:ring-primary-500
    active:bg-primary-800
    disabled:bg-primary-300
  `,
  secondary: `
    bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200
    hover:bg-gray-200 dark:hover:bg-gray-600
    focus:ring-gray-500
    active:bg-gray-300
    disabled:bg-gray-50 dark:disabled:bg-gray-800 disabled:text-gray-500 dark:disabled:text-gray-400
    border border-gray-300 dark:border-gray-600
  `,
  danger: `
    bg-error-600 text-white
    hover:bg-error-700
    focus:ring-error-500
    active:bg-error-800
    disabled:bg-error-300
  `,
  success: `
    bg-success-600 text-white
    hover:bg-success-700
    focus:ring-success-500
    active:bg-success-800
    disabled:bg-success-300
  `,
  warning: `
    bg-warning-600 text-white
    hover:bg-warning-700
    focus:ring-warning-600
    active:bg-warning-800
    disabled:bg-warning-300
  `,
  ghost: `
    bg-transparent text-gray-700 dark:text-gray-300
    hover:bg-gray-100 dark:hover:bg-gray-700
    focus:ring-gray-500
    active:bg-gray-200 dark:active:bg-gray-600
    disabled:text-gray-500 dark:disabled:text-gray-400
  `,
  outline: `
    bg-transparent text-primary-600 dark:text-primary-400
    border border-primary-600
    hover:bg-primary-50 dark:hover:bg-primary-900/30
    focus:ring-primary-500
    active:bg-primary-100 dark:active:bg-primary-900/50
    disabled:text-primary-300 disabled:border-primary-300 dark:disabled:border-primary-700
  `,
};

/**
 * Boyut bazlı stil sınıfları
 */
const sizeStyles: Record<Size, string> = {
  xs: 'px-2 py-1 text-xs min-h-[24px]',
  sm: 'px-3 py-1.5 text-sm min-h-[32px]',
  md: 'px-4 py-2 text-sm min-h-[40px]',
  lg: 'px-5 py-2.5 text-base min-h-[48px]',
  xl: 'px-6 py-3 text-lg min-h-[56px]',
};

/**
 * Glass yüzey stili — buzlu auth kartında `variant` rengini geçersiz kılar.
 * Token'lar var(--surface-btn-*) (primary-600/700) → kart üzerinde AA kontrast.
 */
const glassSurfaceStyle = `
  bg-[var(--surface-btn-bg)] text-[var(--surface-btn-fg)]
  border border-[var(--surface-btn-border)]
  hover:bg-[var(--surface-btn-bg-hover)]
  focus:ring-[var(--surface-btn-bg)]
  disabled:opacity-60
`;

/**
 * Sadece ikon modu için boyut sınıfları
 */
const iconOnlySizeStyles: Record<Size, string> = {
  xs: 'p-1 min-w-[24px] min-h-[24px]',
  sm: 'p-1.5 min-w-[32px] min-h-[32px]',
  md: 'p-2 min-w-[40px] min-h-[40px]',
  lg: 'p-2.5 min-w-[48px] min-h-[48px]',
  xl: 'p-3 min-w-[56px] min-h-[56px]',
};

// ============================================================================
// Loading Spinner Bileşeni
// ============================================================================

const LoadingSpinner: React.FC<{ size: Size }> = ({ size }) => {
  const spinnerSizes: Record<Size, string> = {
    xs: 'w-3 h-3',
    sm: 'w-4 h-4',
    md: 'w-4 h-4',
    lg: 'w-5 h-5',
    xl: 'w-6 h-6',
  };

  return (
    <svg
      className={`animate-spin ${spinnerSizes[size]}`}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
};

// ============================================================================
// Button Bileşeni
// ============================================================================

/**
 * Button bileşeni
 *
 * @example
 * // Temel kullanım
 * <Button onClick={handleClick}>Kaydet</Button>
 *
 * @example
 * // Varyantlar
 * <Button variant="primary">Ana Buton</Button>
 * <Button variant="danger">Sil</Button>
 *
 * @example
 * // İkon ile
 * <Button leftIcon={<PlusIcon />}>Ekle</Button>
 *
 * @example
 * // Yükleniyor durumu
 * <Button isLoading>Kaydediliyor...</Button>
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      fullWidth = false,
      isLoading: isLoadingProp = false,
      loading = false,
      leftIcon,
      rightIcon,
      iconOnly = false,
      surface = 'default',
      disabled,
      className = '',
      children,
      type = 'button',
      ...props
    },
    ref,
  ) => {
    // BUG-017: Warn in development if both loading aliases are supplied
    if (import.meta.env.DEV && isLoadingProp && loading) {
      console.warn(
        'Button: Both `isLoading` and `loading` props are set. Use `isLoading` — `loading` is deprecated.',
      );
    }
    const isLoading = isLoadingProp || loading;
    // Devre dışı durumu (yükleniyor veya disabled prop'u)
    const isDisabled = disabled || isLoading;

    // Stil sınıflarını birleştir
    const baseStyles = `
      inline-flex items-center justify-center
      font-medium rounded-lg
      transition-all duration-200
      focus:outline-hidden focus:ring-2 focus:ring-offset-2
      disabled:cursor-not-allowed
    `;

    const sizeClass = iconOnly ? iconOnlySizeStyles[size] : sizeStyles[size];
    const widthClass = fullWidth ? 'w-full' : '';

    // Glass yüzeyde variant rengini geçersiz kıl (rakip bg-* utility'si olmaması için
    // değiştir, ekleme).
    const variantClass = surface === 'glass' ? glassSurfaceStyle : variantStyles[variant];

    const combinedClassName = `
      ${baseStyles}
      ${variantClass}
      ${sizeClass}
      ${widthClass}
      ${className}
    `
      .replace(/\s+/g, ' ')
      .trim();

    return (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        className={combinedClassName}
        aria-busy={isLoading}
        aria-disabled={isDisabled}
        {...props}
      >
        {/* Yükleniyor durumunda spinner göster */}
        {isLoading && (
          <span className="mr-2">
            <LoadingSpinner size={size} />
          </span>
        )}

        {/* Sol ikon (yükleniyor değilse) */}
        {!isLoading && leftIcon && <span className={children ? 'mr-2' : ''}>{leftIcon}</span>}

        {/* Buton içeriği */}
        {!iconOnly && children}

        {/* Sağ ikon */}
        {rightIcon && <span className={children ? 'ml-2' : ''}>{rightIcon}</span>}
      </button>
    );
  },
);

Button.displayName = 'Button';

// ============================================================================
// Button Grubu Bileşeni
// ============================================================================

export interface ButtonGroupProps {
  /** Alt butonlar */
  children: React.ReactNode;
  /** Dikey yerleşim */
  vertical?: boolean;
  /** Boyut (tüm butonlara uygulanır) */
  size?: Size;
  /** Ek CSS sınıfları */
  className?: string;
}

/**
 * ButtonGroup bileşeni - Birden fazla butonu gruplar
 *
 * @example
 * <ButtonGroup>
 *   <Button>Sol</Button>
 *   <Button>Orta</Button>
 *   <Button>Sağ</Button>
 * </ButtonGroup>
 */
export const ButtonGroup: React.FC<ButtonGroupProps> = ({
  children,
  vertical = false,
  className = '',
}) => {
  const orientationClass = vertical
    ? 'flex-col [&>button]:rounded-none [&>button:first-child]:rounded-t-lg [&>button:last-child]:rounded-b-lg'
    : 'flex-row [&>button]:rounded-none [&>button:first-child]:rounded-l-lg [&>button:last-child]:rounded-r-lg [&>button:not(:last-child)]:border-r-0';

  return (
    <div className={`inline-flex ${orientationClass} ${className}`} role="group">
      {children}
    </div>
  );
};

export default Button;
