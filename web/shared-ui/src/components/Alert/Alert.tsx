/**
 * Alert Bileşeni
 * Bilgilendirme, uyarı ve hata mesajları için bileşenler
 */

import React from 'react';

import { useI18n } from '../../i18n';
import type { NotificationType } from '../../types';
import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react';

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
  /**
   * BUG-006: Accessible label for the dismiss button.
   * Defaults to 'Kapat' (Turkish). Override for other locales.
   */
  dismissLabel?: string;
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

// `focusRing` carries the dismiss-button focus styles as COMPLETE static class
// strings. Two reasons: (1) Tailwind only generates utilities it sees verbatim in
// source — the previous interpolated `ring-offset-${type}-50` was never emitted, so
// the offset color silently did nothing; (2) Tailwind v4's default `ring` color is
// `currentColor` (v3 was blue-500/50), so a bare `ring-2` is no longer deterministic
// — each variant now pins its own ring color.
const typeStyles: Record<
  NotificationType,
  { bg: string; border: string; icon: string; text: string; focusRing: string }
> = {
  success: {
    bg: 'bg-success-50 dark:bg-success-900/20',
    border: 'border-success-400',
    icon: 'text-success-400',
    text: 'text-success-800 dark:text-success-200',
    focusRing: 'focus:ring-success-500 focus:ring-offset-success-50',
  },
  error: {
    bg: 'bg-error-50 dark:bg-error-900/20',
    border: 'border-error-400',
    icon: 'text-error-400',
    text: 'text-error-800 dark:text-error-200',
    focusRing: 'focus:ring-error-500 focus:ring-offset-error-50',
  },
  warning: {
    bg: 'bg-warning-50 dark:bg-warning-900/20',
    border: 'border-warning-400',
    icon: 'text-warning-400',
    text: 'text-warning-800 dark:text-warning-200',
    focusRing: 'focus:ring-warning-500 focus:ring-offset-warning-50',
  },
  info: {
    bg: 'bg-info-50 dark:bg-info-900/20',
    border: 'border-info-400',
    icon: 'text-info-400',
    text: 'text-info-800 dark:text-info-200',
    focusRing: 'focus:ring-info-500 focus:ring-offset-info-50',
  },
};

const typeIcons: Record<NotificationType, React.ReactNode> = {
  success: <CircleCheck className="w-5 h-5" aria-hidden="true" />,
  error: <CircleX className="w-5 h-5" aria-hidden="true" />,
  warning: <TriangleAlert className="w-5 h-5" aria-hidden="true" />,
  info: <Info className="w-5 h-5" aria-hidden="true" />,
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
  dismissLabel: dismissLabelProp,
  action,
  showIcon = true,
  className = '',
}) => {
  const { t } = useI18n();
  const dismissLabel = dismissLabelProp ?? t('common.close');
  // BUG-006: Warn if dismissible=true but no onDismiss handler is provided
  if (dismissible && !onDismiss && import.meta.env.DEV) {
    console.warn(
      'Alert: dismissible={true} but onDismiss is not provided. The dismiss button will have no effect.',
    );
  }

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
        {showIcon && <div className={`flex-shrink-0 ${styles.icon}`}>{typeIcons[type]}</div>}

        {/* İçerik */}
        <div className={`${showIcon ? 'ml-3' : ''} flex-1`}>
          {title && <h3 className={`text-sm font-medium ${styles.text}`}>{title}</h3>}
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
              className={`inline-flex rounded-md p-1.5 ${styles.text} hover:opacity-80 focus:outline-hidden focus:ring-2 focus:ring-offset-2 ${styles.focusRing}`}
            >
              <span className="sr-only">{dismissLabel}</span>
              <X className="h-5 w-5" aria-hidden="true" />
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
  default: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
  success: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  warning: 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
  error: 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200',
  info: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  outline:
    'bg-transparent border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300',
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
      success: 'bg-success-400',
      warning: 'bg-warning-400',
      error: 'bg-error-400',
      info: 'bg-info-400',
      outline: 'bg-gray-400',
    };

    return (
      <span className={`inline-flex items-center ${className}`}>
        <span className={`w-2 h-2 rounded-full ${dotColors[variant]}`} />
        {children && (
          <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">{children}</span>
        )}
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
