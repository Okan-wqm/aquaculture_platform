/**
 * ApiError Component
 * Displays user-friendly error messages with recovery actions
 */
import React from 'react';
import { AppError, ErrorCode, parseError, RecoveryAction } from '../../utils/error-types';

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
  /** Context for error (e.g., "batches", "users") */
  context?: string;
  /** Show technical details (for development) */
  showDetails?: boolean;
  /** Custom class name */
  className?: string;
}

// ============================================================================
// Icon Components
// ============================================================================

const ErrorIcon: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
  <svg className={className} fill="currentColor" viewBox="0 0 20 20">
    <path
      fillRule="evenodd"
      d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
      clipRule="evenodd"
    />
  </svg>
);

const WarningIcon: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
  <svg className={className} fill="currentColor" viewBox="0 0 20 20">
    <path
      fillRule="evenodd"
      d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
      clipRule="evenodd"
    />
  </svg>
);

const NetworkIcon: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3m8.293 8.293l1.414 1.414"
    />
  </svg>
);

const LockIcon: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
    />
  </svg>
);

const RefreshIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
    />
  </svg>
);

// ============================================================================
// Helper Functions
// ============================================================================

function getErrorIcon(code: ErrorCode): React.ReactNode {
  switch (code) {
    case ErrorCode.NETWORK_ERROR:
    case ErrorCode.TIMEOUT:
    case ErrorCode.SERVICE_UNAVAILABLE:
      return <NetworkIcon className="w-5 h-5 text-yellow-400" />;
    case ErrorCode.UNAUTHENTICATED:
    case ErrorCode.TOKEN_EXPIRED:
    case ErrorCode.INVALID_TOKEN:
    case ErrorCode.FORBIDDEN:
    case ErrorCode.INSUFFICIENT_PERMISSION:
      return <LockIcon className="w-5 h-5 text-red-400" />;
    case ErrorCode.BAD_REQUEST:
    case ErrorCode.VALIDATION_ERROR:
      return <WarningIcon className="w-5 h-5 text-orange-400" />;
    default:
      return <ErrorIcon className="w-5 h-5 text-red-400" />;
  }
}

function getErrorColors(code: ErrorCode): { bg: string; border: string; text: string } {
  switch (code) {
    case ErrorCode.NETWORK_ERROR:
    case ErrorCode.TIMEOUT:
    case ErrorCode.SERVICE_UNAVAILABLE:
      return { bg: 'bg-yellow-50', border: 'border-yellow-200', text: 'text-yellow-800' };
    case ErrorCode.BAD_REQUEST:
    case ErrorCode.VALIDATION_ERROR:
      return { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-800' };
    default:
      return { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700' };
  }
}

function getActionButton(
  recoveryAction: RecoveryAction,
  onRetry?: () => void,
  onLogin?: () => void
): React.ReactNode {
  switch (recoveryAction) {
    case 'retry':
      return onRetry ? (
        <button
          onClick={onRetry}
          className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
        >
          <RefreshIcon className="w-4 h-4 mr-1" />
          Tekrar Dene
        </button>
      ) : null;
    case 'login':
      return onLogin ? (
        <button
          onClick={onLogin}
          className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
        >
          Giriş Yap
        </button>
      ) : (
        <a
          href="/login"
          className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
        >
          Giriş Yap
        </a>
      );
    case 'contact_admin':
      return (
        <span className="text-xs text-gray-500">
          Yardım için sistem yöneticinize başvurun
        </span>
      );
    case 'refresh':
      return (
        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-white bg-gray-600 hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500"
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

          {/* Technical details (development only) */}
          {showDetails && (
            <details className="mt-2">
              <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                Teknik detaylar
              </summary>
              <pre className="mt-1 text-xs bg-gray-100 p-2 rounded overflow-auto max-h-32">
                {JSON.stringify(
                  {
                    code: appError.code,
                    message: appError.message,
                    details: appError.details,
                  },
                  null,
                  2
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
