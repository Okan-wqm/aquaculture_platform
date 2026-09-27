/**
 * Error Boundary Component for Tenant Admin Module
 *
 * Catches React errors and displays user-friendly error UI.
 * Supports retry functionality and error reporting.
 */

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Button } from '@aquaculture/shared-ui';
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
        <div className="min-h-[400px] flex items-center justify-center p-8 bg-gray-50 dark:bg-gray-800 rounded-xl">
          <div className="text-center max-w-lg w-full">
            {/* Error Icon */}
            <div className="mx-auto w-16 h-16 bg-error-100 dark:bg-error-900/40 rounded-full flex items-center justify-center mb-6">
              <AlertTriangle className="w-8 h-8 text-error-600 dark:text-error-400" />
            </div>

            {/* Title */}
            <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">
              {moduleName ? `${moduleName} Error` : 'Something went wrong'}
            </h2>

            {/* User Message */}
            <p className="text-gray-600 dark:text-gray-400 mb-6">
              {error?.userMessage || 'An unexpected error occurred. Please try again.'}
            </p>

            {/* Error Code Badge */}
            {error && (
              <div className="mb-6">
                <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">
                  Error Code: {error.code}
                </span>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex flex-col sm:flex-row gap-3 justify-center mb-6">
              {enableRetry && error?.retryable && (
                <Button
                  variant="primary"
                  className="justify-center"
                  leftIcon={<RefreshCw className="w-4 h-4" />}
                  onClick={this.handleRetry}
                >
                  Try Again
                </Button>
              )}
              <Button
                variant="secondary"
                className="justify-center"
                leftIcon={<RefreshCw className="w-4 h-4" />}
                onClick={this.handleRefresh}
              >
                Refresh Page
              </Button>
              <Button
                variant="secondary"
                className="justify-center"
                leftIcon={<Home className="w-4 h-4" />}
                onClick={this.handleGoHome}
              >
                Go to Dashboard
              </Button>
            </div>

            {/* Technical Details (Development) */}
            {import.meta.env.DEV && (error || errorInfo) && (
              <div className="text-left">
                <Button variant="ghost" className="mb-3" onClick={this.toggleDetails}>
                  <Bug className="w-4 h-4" />
                  Technical Details
                  {showDetails ? (
                    <ChevronUp className="w-4 h-4" />
                  ) : (
                    <ChevronDown className="w-4 h-4" />
                  )}
                </Button>

                {showDetails && (
                  <div className="bg-gray-900 rounded-lg p-4 text-left overflow-auto max-h-64">
                    <pre className="text-xs text-success-400 font-mono whitespace-pre-wrap">
                      {JSON.stringify(
                        {
                          code: error?.code,
                          message: error?.message,
                          timestamp: error?.timestamp?.toISOString(),
                          retryable: error?.retryable,
                        },
                        null,
                        2,
                      )}
                    </pre>
                    {errorInfo?.componentStack && (
                      <>
                        <hr className="border-gray-700 my-3" />
                        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                          Component Stack:
                        </p>
                        <pre className="text-xs text-error-400 font-mono whitespace-pre-wrap">
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
    <div className="min-h-[300px] flex items-center justify-center p-6 bg-error-50 dark:bg-error-900/20 rounded-xl border border-error-100 dark:border-error-800">
      <div className="text-center max-w-md">
        <AlertTriangle className="w-12 h-12 text-error-500 mx-auto mb-4" />
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
          {moduleName ? `${moduleName} Error` : 'Error'}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          {processedError.userMessage}
        </p>
        <div className="flex justify-center gap-3">
          {processedError.retryable && (
            <Button
              variant="primary"
              leftIcon={<RefreshCw className="w-4 h-4" />}
              onClick={resetErrorBoundary}
            >
              Try Again
            </Button>
          )}
          <Button variant="secondary" onClick={() => window.location.reload()}>
            Refresh Page
          </Button>
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
export const PageErrorBoundary: React.FC<PageErrorBoundaryProps> = ({ children, pageName }) => {
  return (
    <ErrorBoundary moduleName={pageName} enableRetry>
      {children}
    </ErrorBoundary>
  );
};

export default ErrorBoundary;
