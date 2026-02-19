/**
 * Error Boundary Component
 *
 * React error boundary — catches errors in microfrontend modules
 * and displays a user-friendly message.
 */

import React, { Component, ErrorInfo } from 'react';
import { Button } from '@aquaculture/shared-ui';

// ============================================================================
// Types
// ============================================================================

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Module name shown in the error message */
  moduleName?: string;
  /** Custom fallback to render instead of the default error UI */
  fallback?: React.ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

// ============================================================================
// Error Boundary Component
// ============================================================================

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });

    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }

    // TODO: send to error reporting service (e.g. Sentry)
    if (import.meta.env.DEV) {
      console.error('Module Error:', error, errorInfo);
    }
  }

  handleRefresh = (): void => {
    window.location.reload();
  };

  handleRetry = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  /**
   * Navigate to home page
   */
  handleGoHome = (): void => {
    window.location.href = '/';
  };

  render(): React.ReactNode {
    const { hasError, error } = this.state;
    const { children, moduleName, fallback } = this.props;

    if (hasError) {
      if (fallback) {
        return fallback;
      }

      return (
        <div className="min-h-[400px] flex items-center justify-center p-8">
          <div className="text-center max-w-md">
            <div className="mx-auto w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mb-4">
              <svg
                className="w-8 h-8 text-red-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>

            <h2 className="text-xl font-semibold text-gray-900 mb-2">
              {moduleName ? `Failed to Load ${moduleName}` : 'An Error Occurred'}
            </h2>

            <p className="text-gray-600 mb-6">
              An unexpected error occurred. Please refresh the page or try again later.
            </p>

            {import.meta.env.DEV && error && (
              <div className="mb-6 p-4 bg-gray-100 rounded-lg text-left">
                <p className="text-sm font-mono text-red-600 break-all">
                  {error.message}
                </p>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Button variant="primary" onClick={this.handleRetry}>
                Retry
              </Button>
              <Button variant="outline" onClick={this.handleRefresh}>
                Refresh Page
              </Button>
              <Button variant="ghost" onClick={this.handleGoHome}>
                Go to Home
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return children;
  }
}

export default ErrorBoundary;
