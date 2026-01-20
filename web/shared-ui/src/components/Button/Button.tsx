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
}

// ============================================================================
// Stil Sınıfları
// ============================================================================

/**
 * Varyant bazlı stil sınıfları
 */
const variantStyles: Record<ButtonVariant, string> = {
  primary: `
    bg-blue-600 text-white
    hover:bg-blue-700
    focus:ring-blue-500
    active:bg-blue-800
    disabled:bg-blue-300
  `,
  secondary: `
    bg-gray-100 text-gray-800
    hover:bg-gray-200
    focus:ring-gray-500
    active:bg-gray-300
    disabled:bg-gray-50 disabled:text-gray-400
    border border-gray-300
  `,
  danger: `
    bg-red-600 text-white
    hover:bg-red-700
    focus:ring-red-500
    active:bg-red-800
    disabled:bg-red-300
  `,
  success: `
    bg-green-600 text-white
    hover:bg-green-700
    focus:ring-green-500
    active:bg-green-800
    disabled:bg-green-300
  `,
  warning: `
    bg-yellow-500 text-white
    hover:bg-yellow-600
    focus:ring-yellow-500
    active:bg-yellow-700
    disabled:bg-yellow-300
  `,
  ghost: `
    bg-transparent text-gray-700
    hover:bg-gray-100
    focus:ring-gray-500
    active:bg-gray-200
    disabled:text-gray-400
  `,
  outline: `
    bg-transparent text-blue-600
    border border-blue-600
    hover:bg-blue-50
    focus:ring-blue-500
    active:bg-blue-100
    disabled:text-blue-300 disabled:border-blue-300
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
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
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
      disabled,
      className = '',
      children,
      type = 'button',
      ...props
    },
    ref
  ) => {
    // loading ve isLoading'i birleştir
    const isLoading = isLoadingProp || loading;
    // Devre dışı durumu (yükleniyor veya disabled prop'u)
    const isDisabled = disabled || isLoading;

    // Stil sınıflarını birleştir
    const baseStyles = `
      inline-flex items-center justify-center
      font-medium rounded-lg
      transition-all duration-200
      focus:outline-none focus:ring-2 focus:ring-offset-2
      disabled:cursor-not-allowed
    `;

    const sizeClass = iconOnly ? iconOnlySizeStyles[size] : sizeStyles[size];
    const widthClass = fullWidth ? 'w-full' : '';

    const combinedClassName = `
      ${baseStyles}
      ${variantStyles[variant]}
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
        {!isLoading && leftIcon && (
          <span className={children ? 'mr-2' : ''}>{leftIcon}</span>
        )}

        {/* Buton içeriği */}
        {!iconOnly && children}

        {/* Sağ ikon */}
        {rightIcon && <span className={children ? 'ml-2' : ''}>{rightIcon}</span>}
      </button>
    );
  }
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
    <div
      className={`inline-flex ${orientationClass} ${className}`}
      role="group"
    >
      {children}
    </div>
  );
};

export default Button;
