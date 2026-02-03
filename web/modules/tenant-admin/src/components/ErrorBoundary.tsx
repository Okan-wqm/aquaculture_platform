/**
 * Error Boundary Component for Tenant Admin Module
 *
 * Catches React errors and displays user-friendly error UI.
 * Supports retry functionality and error reporting.
 */

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Home, Bug, ChevronDown, ChevronUp } from 'lucide-react';
import { logError, processError, type AppError } from '../utils/error-handling';

// ============================================================================
// Types
// ============================================================================

interface ErrorBoundaryProps {
  /** Child components */
  children: ReactNode;
  /** Module/section name for error messages */
  moduleName?: string;
  /** Custom fallback component */
  fallback?: ReactNode;
  /** Error callback for external handling */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** Enable retry functionality */
  enableRetry?: boolean;
  /** Custom retry handler */
  onRetry?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: AppError | null;
  errorInfo: ErrorInfo | null;
  showDetails: boolean;
}

// ============================================================================
// Error Boundary Component
// ============================================================================

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      showDetails: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    const processedError = processError(error);
    return {
      hasError: true,
      error: processedError,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });

    // Log error
    logError(`ErrorBoundary:${this.props.moduleName || 'TenantAdmin'}`, error, {
      componentStack: errorInfo.componentStack,
    });

    // Call external error handler if provided
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  handleRetry = (): void => {
    if (this.props.onRetry) {
      this.props.onRetry();
    }
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      showDetails: false,
    });
  };

  handleRefresh = (): void => {
    window.location.reload();
  };

  handleGoHome = (): void => {
    window.location.href = '/tenant';
  };

  toggleDetails = (): void => {
    this.setState((prev) => ({ showDetails: !prev.showDetails }));
  };

  render(): ReactNode {
    const { hasError, error, errorInfo, showDetails } = this.state;
    const { children, moduleName, fallback, enableRetry = true } = this.props;

    if (hasError) {
      // Custom fallback if provided
      if (fallback) {
        return fallback;
      }

      return (
        <div className="min-h-[400px] flex items-center justify-center p-8 bg-gray-50 rounded-xl">
          <div className="text-center max-w-lg w-full">
            {/* Error Icon */}
            <div className="mx-auto w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mb-6">
              <AlertTriangle className="w-8 h-8 text-red-600" />
            </div>

            {/* Title */}
            <h2 className="text-xl font-bold text-gray-900 mb-2">
              {moduleName ? `${moduleName} Error` : 'Something went wrong'}
            </h2>

            {/* User Message */}
            <p className="text-gray-600 mb-6">
              {error?.userMessage || 'An unexpected error occurred. Please try again.'}
            </p>

            {/* Error Code Badge */}
            {error && (
              <div className="mb-6">
                <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                  Error Code: {error.code}
                </span>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex flex-col sm:flex-row gap-3 justify-center mb-6">
              {enableRetry && error?.retryable && (
                <button
                  onClick={this.handleRetry}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-tenant-600 rounded-lg hover:bg-tenant-700 transition-colors"
                >
                  <RefreshCw className="w-4 h-4" />
                  Try Again
                </button>
              )}
              <button
                onClick={this.handleRefresh}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                Refresh Page
              </button>
              <button
                onClick={this.handleGoHome}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
              >
                <Home className="w-4 h-4" />
                Go to Dashboard
              </button>
            </div>

            {/* Technical Details (Development) */}
            {import.meta.env.DEV && (error || errorInfo) && (
              <div className="text-left">
                <button
                  onClick={this.toggleDetails}
                  className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 mb-3"
                >
                  <Bug className="w-4 h-4" />
                  Technical Details
                  {showDetails ? (
                    <ChevronUp className="w-4 h-4" />
                  ) : (
                    <ChevronDown className="w-4 h-4" />
                  )}
                </button>

                {showDetails && (
                  <div className="bg-gray-900 rounded-lg p-4 text-left overflow-auto max-h-64">
                    <pre className="text-xs text-green-400 font-mono whitespace-pre-wrap">
                      {JSON.stringify(
                        {
                          code: error?.code,
                          message: error?.message,
                          timestamp: error?.timestamp?.toISOString(),
                          retryable: error?.retryable,
                        },
                        null,
                        2
                      )}
                    </pre>
                    {errorInfo?.componentStack && (
                      <>
                        <hr className="border-gray-700 my-3" />
                        <p className="text-xs text-gray-400 mb-2">Component Stack:</p>
                        <pre className="text-xs text-red-400 font-mono whitespace-pre-wrap">
                          {errorInfo.componentStack}
                        </pre>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      );
    }

    return children;
  }
}

// ============================================================================
// Error Fallback Component (for use with react-error-boundary)
// ============================================================================

interface ErrorFallbackProps {
  error: Error;
  resetErrorBoundary: () => void;
  moduleName?: string;
}

export const ErrorFallback: React.FC<ErrorFallbackProps> = ({
  error,
  resetErrorBoundary,
  moduleName,
}) => {
  const processedError = processError(error);

  return (
    <div className="min-h-[300px] flex items-center justify-center p-6 bg-red-50 rounded-xl border border-red-100">
      <div className="text-center max-w-md">
        <AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-4" />
        <h3 className="text-lg font-semibold text-gray-900 mb-2">
          {moduleName ? `${moduleName} Error` : 'Error'}
        </h3>
        <p className="text-sm text-gray-600 mb-4">{processedError.userMessage}</p>
        <div className="flex justify-center gap-3">
          {processedError.retryable && (
            <button
              onClick={resetErrorBoundary}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-tenant-600 rounded-lg hover:bg-tenant-700 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Try Again
            </button>
          )}
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Refresh Page
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Page Error Boundary Wrapper
// ============================================================================

interface PageErrorBoundaryProps {
  children: ReactNode;
  pageName: string;
}

/**
 * Specialized error boundary for page-level errors
 */
export const PageErrorBoundary: React.FC<PageErrorBoundaryProps> = ({
  children,
  pageName,
}) => {
  return (
    <ErrorBoundary moduleName={pageName} enableRetry>
      {children}
    </ErrorBoundary>
  );
};

export default ErrorBoundary;
