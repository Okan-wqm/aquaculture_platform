/**
 * ApiError Component
 * Displays user-friendly error messages with recovery actions
 */
import React from 'react';
import { AppError, ErrorCode, parseError, RecoveryAction } from '../../utils/error-types';
import { CircleX, Lock, RefreshCw, TriangleAlert, VolumeX } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

export interface ApiErrorProps {
  /** Error object or AppError */
  error: Error | AppError | null;
  /** Callback for retry action */
  onRetry?: () => void;
  /** Callback for login action */
  onLogin?: () => void;
  /**
   * SEC-010: Context for error (e.g., "batches", "users").
   * Must be a static developer-defined string — do NOT pass user-supplied input here.
   * The value is rendered as text via JSX interpolation (React-escaped), so XSS is
   * prevented as long as `dangerouslySetInnerHTML` is never used at this location.
   */
  context?: string;
  /**
   * SEC-011: Show technical error details including stack/GraphQL errors.
   * This prop is only honoured in non-production environments.
   * Never set to `true` in production code.
   */
  showDetails?: boolean;
  /** Custom class name */
  className?: string;
}

// ============================================================================
// Icon Components
// ============================================================================

const ErrorIcon: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
  <CircleX className={className} aria-hidden="true" />
);

const WarningIcon: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
  <TriangleAlert className={className} aria-hidden="true" />
);

const NetworkIcon: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
  <VolumeX className={className} aria-hidden="true" />
);

const LockIcon: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
  <Lock className={className} aria-hidden="true" />
);

const RefreshIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <RefreshCw className={className} aria-hidden="true" />
);

// ============================================================================
// Helper Functions
// ============================================================================

function getErrorIcon(code: ErrorCode): React.ReactNode {
  switch (code) {
    case ErrorCode.NETWORK_ERROR:
    case ErrorCode.TIMEOUT:
    case ErrorCode.SERVICE_UNAVAILABLE:
      return <NetworkIcon className="w-5 h-5 text-warning-400" />;
    case ErrorCode.UNAUTHENTICATED:
    case ErrorCode.TOKEN_EXPIRED:
    case ErrorCode.INVALID_TOKEN:
    case ErrorCode.FORBIDDEN:
    case ErrorCode.INSUFFICIENT_PERMISSION:
      return <LockIcon className="w-5 h-5 text-error-400" />;
    case ErrorCode.BAD_REQUEST:
    case ErrorCode.VALIDATION_ERROR:
      return <WarningIcon className="w-5 h-5 text-warning-400" />;
    default:
      return <ErrorIcon className="w-5 h-5 text-error-400" />;
  }
}

function getErrorColors(code: ErrorCode): { bg: string; border: string; text: string } {
  switch (code) {
    case ErrorCode.NETWORK_ERROR:
    case ErrorCode.TIMEOUT:
    case ErrorCode.SERVICE_UNAVAILABLE:
      return { bg: 'bg-warning-50', border: 'border-warning-200', text: 'text-warning-800' };
    case ErrorCode.BAD_REQUEST:
    case ErrorCode.VALIDATION_ERROR:
      return { bg: 'bg-warning-50', border: 'border-warning-200', text: 'text-warning-800' };
    default:
      return { bg: 'bg-error-50', border: 'border-error-200', text: 'text-error-700' };
  }
}

function getActionButton(
  recoveryAction: RecoveryAction,
  onRetry?: () => void,
  onLogin?: () => void,
): React.ReactNode {
  switch (recoveryAction) {
    case 'retry':
      return onRetry ? (
        <button
          onClick={onRetry}
          className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-white bg-error-600 hover:bg-error-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-error-500"
        >
          <RefreshIcon className="w-4 h-4 mr-1" />
          Tekrar Dene
        </button>
      ) : null;
    case 'login':
      return onLogin ? (
        <button
          onClick={onLogin}
          className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
        >
          Giriş Yap
        </button>
      ) : (
        <a
          href="/login"
          className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
        >
          Giriş Yap
        </a>
      );
    case 'contact_admin':
      return (
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Yardım için sistem yöneticinize başvurun
        </span>
      );
    case 'refresh':
      return (
        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-white bg-gray-600 hover:bg-gray-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-gray-500"
        >
          <RefreshIcon className="w-4 h-4 mr-1" />
          Sayfayı Yenile
        </button>
      );
    default:
      return null;
  }
}

// ============================================================================
// Component
// ============================================================================

export const ApiError: React.FC<ApiErrorProps> = ({
  error,
  onRetry,
  onLogin,
  context,
  showDetails = false,
  className = '',
}) => {
  if (!error) return null;

  // Parse error if it's a raw Error
  const appError: AppError = 'code' in error ? error : parseError(error);

  const colors = getErrorColors(appError.code);
  const icon = getErrorIcon(appError.code);
  const actionButton = getActionButton(appError.recoveryAction, onRetry, onLogin);

  return (
    <div className={`${colors.bg} border ${colors.border} rounded-lg p-4 ${className}`}>
      <div className="flex items-start">
        <div className="flex-shrink-0">{icon}</div>
        <div className="ml-3 flex-1">
          <p className={`text-sm font-medium ${colors.text}`}>
            {context ? `${context} yüklenirken hata oluştu` : 'Hata oluştu'}
          </p>
          <p className={`mt-1 text-sm ${colors.text}`}>{appError.userMessage}</p>

          {/* Technical details (SEC-011: only shown in development — never in production) */}
          {showDetails && import.meta.env.DEV && (
            <details className="mt-2">
              <summary className="text-xs text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-100">
                Teknik detaylar
              </summary>
              <pre className="mt-1 text-xs bg-gray-100 dark:bg-gray-800 p-2 rounded overflow-auto max-h-32">
                {JSON.stringify(
                  {
                    code: appError.code,
                    message: appError.message,
                    details: appError.details,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          )}

          {/* Action button */}
          {actionButton && <div className="mt-3">{actionButton}</div>}
        </div>
      </div>
    </div>
  );
};

export default ApiError;
