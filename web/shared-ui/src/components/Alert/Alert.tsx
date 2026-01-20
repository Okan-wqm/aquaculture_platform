/**
 * Alert Bileşeni
 * Bilgilendirme, uyarı ve hata mesajları için bileşenler
 */

import React from 'react';
import type { NotificationType } from '../../types';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

export interface AlertProps {
  /** Alert türü */
  type: NotificationType;
  /** Başlık */
  title?: string;
  /** Mesaj içeriği */
  children: React.ReactNode;
  /** Kapatılabilir mi */
  dismissible?: boolean;
  /** Kapatma işleyicisi */
  onDismiss?: () => void;
  /** Aksiyon butonu */
  action?: {
    label: string;
    onClick: () => void;
  };
  /** Ikon göster */
  showIcon?: boolean;
  className?: string;
}

// ============================================================================
// Stil Tanımlamaları
// ============================================================================

const typeStyles: Record<NotificationType, { bg: string; border: string; icon: string; text: string }> = {
  success: {
    bg: 'bg-green-50',
    border: 'border-green-400',
    icon: 'text-green-400',
    text: 'text-green-800',
  },
  error: {
    bg: 'bg-red-50',
    border: 'border-red-400',
    icon: 'text-red-400',
    text: 'text-red-800',
  },
  warning: {
    bg: 'bg-yellow-50',
    border: 'border-yellow-400',
    icon: 'text-yellow-400',
    text: 'text-yellow-800',
  },
  info: {
    bg: 'bg-blue-50',
    border: 'border-blue-400',
    icon: 'text-blue-400',
    text: 'text-blue-800',
  },
};

const typeIcons: Record<NotificationType, React.ReactNode> = {
  success: (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
    </svg>
  ),
  error: (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
    </svg>
  ),
  warning: (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
      <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
    </svg>
  ),
  info: (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
    </svg>
  ),
};

// ============================================================================
// Alert Bileşeni
// ============================================================================

/**
 * Alert bileşeni
 *
 * @example
 * <Alert type="success" title="Başarılı">
 *   Çiftlik başarıyla oluşturuldu.
 * </Alert>
 *
 * @example
 * <Alert
 *   type="error"
 *   title="Hata"
 *   dismissible
 *   onDismiss={() => setShowError(false)}
 * >
 *   İşlem sırasında bir hata oluştu.
 * </Alert>
 */
export const Alert: React.FC<AlertProps> = ({
  type,
  title,
  children,
  dismissible = false,
  onDismiss,
  action,
  showIcon = true,
  className = '',
}) => {
  const styles = typeStyles[type];

  return (
    <div
      className={`
        rounded-lg border-l-4 p-4
        ${styles.bg} ${styles.border}
        ${className}
      `}
      role="alert"
    >
      <div className="flex">
        {/* İkon */}
        {showIcon && (
          <div className={`flex-shrink-0 ${styles.icon}`}>
            {typeIcons[type]}
          </div>
        )}

        {/* İçerik */}
        <div className={`${showIcon ? 'ml-3' : ''} flex-1`}>
          {title && (
            <h3 className={`text-sm font-medium ${styles.text}`}>{title}</h3>
          )}
          <div className={`${title ? 'mt-1' : ''} text-sm ${styles.text} opacity-90`}>
            {children}
          </div>

          {/* Aksiyon butonu */}
          {action && (
            <div className="mt-3">
              <button
                type="button"
                onClick={action.onClick}
                className={`text-sm font-medium ${styles.text} underline hover:opacity-80`}
              >
                {action.label}
              </button>
            </div>
          )}
        </div>

        {/* Kapatma butonu */}
        {dismissible && (
          <div className="ml-auto pl-3">
            <button
              type="button"
              onClick={onDismiss}
              className={`inline-flex rounded-md p-1.5 ${styles.text} hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-${type === 'success' ? 'green' : type === 'error' ? 'red' : type === 'warning' ? 'yellow' : 'blue'}-50`}
            >
              <span className="sr-only">Kapat</span>
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// Badge Bileşeni
// ============================================================================

export interface BadgeProps {
  /** Badge türü/rengi */
  variant?: 'default' | 'success' | 'warning' | 'error' | 'info' | 'outline';
  /** Boyut */
  size?: 'sm' | 'md' | 'lg';
  /** İçerik */
  children: React.ReactNode;
  /** Nokta göster (içerik yerine) */
  dot?: boolean;
  className?: string;
}

const badgeVariants = {
  default: 'bg-gray-100 text-gray-800',
  success: 'bg-green-100 text-green-800',
  warning: 'bg-yellow-100 text-yellow-800',
  error: 'bg-red-100 text-red-800',
  info: 'bg-blue-100 text-blue-800',
  outline: 'bg-transparent border border-gray-300 text-gray-700',
};

const badgeSizes = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-2.5 py-0.5 text-sm',
  lg: 'px-3 py-1 text-sm',
};

/**
 * Badge bileşeni
 *
 * @example
 * <Badge variant="success">Aktif</Badge>
 * <Badge variant="error" size="sm">Hata</Badge>
 */
export const Badge: React.FC<BadgeProps> = ({
  variant = 'default',
  size = 'md',
  children,
  dot = false,
  className = '',
}) => {
  if (dot) {
    const dotColors = {
      default: 'bg-gray-400',
      success: 'bg-green-400',
      warning: 'bg-yellow-400',
      error: 'bg-red-400',
      info: 'bg-blue-400',
      outline: 'bg-gray-400',
    };

    return (
      <span className={`inline-flex items-center ${className}`}>
        <span className={`w-2 h-2 rounded-full ${dotColors[variant]}`} />
        {children && <span className="ml-2 text-sm text-gray-700">{children}</span>}
      </span>
    );
  }

  return (
    <span
      className={`
        inline-flex items-center font-medium rounded-full
        ${badgeVariants[variant]}
        ${badgeSizes[size]}
        ${className}
      `}
    >
      {children}
    </span>
  );
};

export default Alert;
